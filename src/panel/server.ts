import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_PROFILES } from "../agent/marketingAgent.js";
import { mimeOf } from "../channels/http.js";
import { CONTENT_EXTENSIONS, loadConfig, type AgentConfig, type LlmSpeed } from "../config.js";
import { generateForAll, generateForItem, type GenerationProgress } from "../generator.js";
import { ingest } from "../ingest.js";
import { applyLocalLlm, chat, chatStream, type LlmOptions } from "../llm.js";
import { CHANNEL_LIMITS, publishSingle, scheduleDrafts, scheduleSingle } from "../publisher.js";
import { Store } from "../storage.js";
import type { ChannelId } from "../types.js";
import { applyUiConfig, loadChannelLlm, loadConnectors, loadUiConfig, saveChannelLlm, saveConnectors, saveUiConfig, uiConfigFile, UI_CONFIG_KEYS, type ConnectorConfig, type UiConfigVars } from "../uiconfig.js";

/** Límite de subida de media (300 MB: sobra para fotos y la mayoría de vídeos). */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

/** Sesión de generación en curso (progreso en vivo del panel vía polling). */
interface GenerationState {
  running: boolean;
  currentItem?: string;
  index: number;
  total: number;
  generated: number;
  startedAt: number;
  error?: string;
  ms?: number;
}
let generation: GenerationState | null = null;

/** Arranca una generación en segundo plano (o falla si ya hay una en curso).
 *  Lo usan POST /api/generate y las órdenes del chat. */
function startGeneration(config: AgentConfig, itemId?: string): { ok: true } | { ok: false; error: string } {
  if (generation?.running) return { ok: false, error: "Ya hay una generación en curso. Espera a que termine." };
  const startedAt = Date.now();
  generation = { running: true, currentItem: undefined, index: 0, total: 0, generated: 0, startedAt };
  const update = (p: GenerationProgress): void => {
    if (generation) Object.assign(generation, p);
  };
  const genStore = new Store(config.dataFile);
  const run = itemId ? generateForItem(config, genStore, itemId, update) : generateForAll(config, genStore, update);
  run
    .then((result) => {
      if (!generation) return;
      Object.assign(generation, {
        running: false,
        currentItem: undefined,
        index: generation.total,
        ...result,
        ms: Date.now() - startedAt,
      });
    })
    .catch((err) => {
      if (!generation) return;
      Object.assign(generation, {
        running: false,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - startedAt,
      });
    });
  return { ok: true };
}

/** Ruta del HTML del panel: se lee en runtime desde src (sin paso de build). */
function panelHtmlPath(config: AgentConfig): string {
  const fromSrc = join(config.root, "src", "panel", "index.html");
  if (existsSync(fromSrc)) return fromSrc;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  // dist/panel → ../../src/panel (desde el build) · junto al server compilado · src/panel
  const candidates = [
    join(moduleDir, "..", "..", "src", "panel", "index.html"),
    join(moduleDir, "index.html"),
    join(moduleDir, "..", "panel", "index.html"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return join(moduleDir, "index.html");
}

/** Runtime del panel: la config puede cambiarse en vivo desde /api/config. */
interface Runtime {
  config: AgentConfig;
}

/** Arranca el panel web. Devuelve el servidor (útil para tests con puerto 0). */
export function startPanel(config: AgentConfig, port: number): Server {
  const runtime: Runtime = { config };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      await route(runtime, req.method ?? "GET", url.pathname, req, res);
    } catch (err) {
      if (res.headersSent) {
        res.end();
      } else {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`El puerto ${port} ya está en uso. Prueba con otro: PANEL_PORT=5000 npm run panel`);
    } else {
      console.error("Error del servidor:", err.message);
    }
    process.exit(1);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

async function route(
  runtime: Runtime,
  method: string,
  pathname: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const config = runtime.config;
  // Panel HTML.
  if (method === "GET" && pathname === "/") {
    const html = readFileSync(panelHtmlPath(config), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // Media estática (previews).
  if (method === "GET" && pathname.startsWith("/media/")) {
    const fileName = decodeURIComponent(pathname.slice("/media/".length));
    const file = join(config.mediaDir, fileName);
    if (!file.startsWith(config.mediaDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      sendJson(res, 404, { error: "Media no encontrada" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeOf(file),
      "Cache-Control": "no-cache",
      "Content-Length": String(statSync(file).size),
    });
    res.end(readFileSync(file));
    return;
  }

  // API REST.
  if (pathname.startsWith("/api/")) {
    await handleApi(runtime, method, pathname, req, res);
    return;
  }

  sendJson(res, 404, { error: "Ruta no encontrada" });
}

async function handleApi(
  runtime: Runtime,
  method: string,
  pathname: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const config = runtime.config;
  // El store se carga fresco en cada petición para ver cambios externos.
  const store = new Store(config.dataFile);
  const raw = await readBodyBuffer(req);
  const body = raw.toString("utf8");
  // Cuerpo tolerante: las subidas de media son binarias (no JSON).
  let json: Record<string, unknown> = {};
  try {
    json = body ? JSON.parse(body) : {};
  } catch {
    /* cuerpo no-JSON: las rutas JSON validarán sus propios campos */
  }
  const match = pathname.match(/^\/api\/posts\/([^/]+)\/([a-z-]+)$/);

  // Progreso en vivo de la generación.
  if (method === "GET" && pathname === "/api/generation") {
    return sendJson(res, 200, generation ?? { running: false, index: 0, total: 0, generated: 0 });
  }

  // Generación de drafts con IA: arranca en segundo plano y devuelve 202;
  // el panel consulta /api/generation para ver el progreso por ítem.
  if (method === "POST" && pathname === "/api/generate") {
    const itemId = typeof json.itemId === "string" ? json.itemId : undefined;
    const started = startGeneration(config, itemId);
    if (!started.ok) return sendJson(res, 409, { error: started.error });
    return sendJson(res, 202, { ok: true });
  }

  // Subida de media: cuerpo crudo + nombre en X-File-Name (sin multipart).
  if (method === "POST" && pathname === "/api/media") {
    const fileName = decodeURIComponent(String(req.headers["x-file-name"] ?? "")).trim();
    const safeName = basename(fileName).replace(/[^\w.\-() ]+/g, "_").trim();
    const ext = extname(safeName).toLowerCase();
    if (!CONTENT_EXTENSIONS.includes(ext)) {
      return sendJson(res, 400, {
        error: `Extensión no soportada: ${ext || "(sin extensión)"}. Permite: ${CONTENT_EXTENSIONS.join(", ")}`,
      });
    }
    if (!safeName || raw.length === 0) return sendJson(res, 400, { error: "Archivo vacío o sin nombre." });
    if (raw.length > MAX_UPLOAD_BYTES) return sendJson(res, 413, { error: "El archivo supera el límite de 300 MB." });
    mkdirSync(config.mediaDir, { recursive: true });
    let final = safeName;
    let i = 1;
    while (existsSync(join(config.mediaDir, final))) final = `${basename(safeName, ext)}-${i++}${ext}`;
    writeFileSync(join(config.mediaDir, final), raw);
    const added = ingest(config, store);
    const item = store.contentItems.find((it) => it.filePath === join(config.mediaDir, final));
    return sendJson(res, 200, { ok: true, file: final, itemId: item?.id, ingested: added.length });
  }

  // Borrar un ítem de contenido (idea o media) y su archivo fuente.
  if (method === "DELETE" && pathname.startsWith("/api/items/")) {
    const itemId = decodeURIComponent(pathname.slice("/api/items/".length));
    const item = store.getContentItem(itemId);
    if (!item) return sendJson(res, 404, { error: "Ítem no encontrado" });
    const { postsRemoved } = store.removeContentItem(itemId);
    // Borra también el archivo fuente (.md de idea o la media), solo si está
    // dentro de las carpetas de contenido del proyecto.
    const source = item.sourceFile ?? item.filePath;
    if (source) {
      const abs = resolve(source);
      const inside =
        abs.startsWith(resolve(config.ideasDir) + sep) || abs.startsWith(resolve(config.mediaDir) + sep);
      if (inside && existsSync(abs) && statSync(abs).isFile()) {
        try {
          unlinkSync(abs);
        } catch {
          /* el borrado lógico no debe fallar por no poder borrar el archivo */
        }
      }
    }
    return sendJson(res, 200, { ok: true, itemId, postsRemoved });
  }

  // Subida de una idea como archivo de texto (.md/.txt), para arrastrar a la pestaña.
  if (method === "POST" && pathname === "/api/ideas-file") {
    const fileName = decodeURIComponent(String(req.headers["x-file-name"] ?? "")).trim();
    const safeName = basename(fileName).replace(/[^\w.\-() ]+/g, "_").trim();
    const ext = extname(safeName).toLowerCase();
    if (![".md", ".txt", ".markdown"].includes(ext)) {
      return sendJson(res, 400, { error: "Solo se aceptan archivos de texto (.md, .txt, .markdown)." });
    }
    if (!safeName || raw.length === 0) return sendJson(res, 400, { error: "Archivo vacío o sin nombre." });
    mkdirSync(config.ideasDir, { recursive: true });
    let final = safeName;
    let n = 1;
    while (existsSync(join(config.ideasDir, final))) final = `${basename(safeName, ext)}-${n++}${ext}`;
    writeFileSync(join(config.ideasDir, final), raw);
    ingest(config, store);
    const item = store.contentItems.find((it) => it.sourceFile === join(config.ideasDir, final));
    return sendJson(res, 200, { ok: true, file: final, itemId: item?.id });
  }

  // Importar un vídeo por URL (YouTube/TikTok) usando yt-dlp.
  if (method === "POST" && pathname === "/api/import-url") {
    const url = typeof json.url === "string" ? json.url.trim() : "";
    if (!url) return sendJson(res, 400, { error: "Pega la URL del vídeo." });
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return sendJson(res, 400, { error: "La URL no es válida." });
    }
    const allowed =
      /(^|\.)youtube\.com$/.test(host) ||
      /(^|\.)youtu\.be$/.test(host) ||
      /(^|\.)tiktok\.com$/.test(host);
    if (!allowed) return sendJson(res, 400, { error: "Solo se aceptan URLs de YouTube o TikTok." });

    const ytdlp = findYtDlp(config);
    if (!ytdlp) {
      return sendJson(res, 503, {
        error: "No se encontró yt-dlp. Ejecuta npm run setup:tools para descargarlo (gratis).",
      });
    }
    mkdirSync(config.mediaDir, { recursive: true });
    const before = new Set(readdirSync(config.mediaDir));
    try {
      await runYtDlp(ytdlp, [
        "--no-playlist",
        "--no-progress",
        "--js-runtimes",
        "node", // la app ya corre en Node: ayuda a resolver el challenge de YouTube
        "--restrict-filenames",
        "-f",
        "best[height<=1080][ext=mp4]/best[height<=1080]/best",
        "-o",
        join(config.mediaDir, "%(title)s [%(id)s].%(ext)s"),
        url,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = msg.includes("403") || msg.includes("DRM") || msg.includes("challenge")
        ? " YouTube/TikTok pueden bloquear descargas desde tu red; prueba en otra conexión o con tu cuenta (cookies)."
        : "";
      return sendJson(res, 502, { error: `Descarga fallida: ${msg}.${hint}` });
    }
    const downloaded = readdirSync(config.mediaDir).find((f) => !before.has(f));
    if (!downloaded) {
      return sendJson(res, 502, { error: "La descarga no produjo ningún archivo." });
    }
    const size = statSync(join(config.mediaDir, downloaded)).size;
    if (size > 500 * 1024 * 1024) {
      try {
        unlinkSync(join(config.mediaDir, downloaded));
      } catch {
        /* no bloquea */
      }
      return sendJson(res, 502, { error: "El vídeo supera los 500 MB; no se guardó." });
    }
    ingest(config, store);
    const item = store.contentItems.find((it) => it.sourceFile === join(config.mediaDir, downloaded));
    return sendJson(res, 200, { ok: true, file: downloaded, sizeMb: Math.round(size / 1024 / 1024), itemId: item?.id });
  }

  // Añadir una idea de contenido (se guarda como .md e ingesta).
  if (method === "POST" && pathname === "/api/ideas") {
    const title = typeof json.title === "string" ? json.title.trim() : "";
    if (!title) return sendJson(res, 400, { error: "Falta el título de la idea." });
    const ideaBody = typeof json.body === "string" ? json.body.trim() : "";
    mkdirSync(config.ideasDir, { recursive: true });
    const slug =
      title
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "idea";
    let file = `${slug}.md`;
    let n = 1;
    while (existsSync(join(config.ideasDir, file))) file = `${slug}-${n++}.md`;
    writeFileSync(join(config.ideasDir, file), ideaBody ? `${title}\n\n${ideaBody}\n` : `${title}\n`);
    ingest(config, store);
    const item = store.contentItems.find((it) => it.kind === "idea" && it.title === title);
    return sendJson(res, 200, { ok: true, file, itemId: item?.id });
  }

  // ── Configuración de la IA (página ⚙️ Config + wizard del primer arranque) ──
  if (method === "GET" && pathname === "/api/config") {
    return sendJson(res, 200, configView(config, loadUiConfig(config.root)));
  }

  // Ver/descargar el .env de la raíz del proyecto (panel local: solo 127.0.0.1).
  if (method === "GET" && pathname === "/api/config/env") {
    const envFile = join(config.root, ".env");
    if (!existsSync(envFile) || !statSync(envFile).isFile()) {
      return sendJson(res, 404, { error: "No hay .env en la raíz del proyecto." });
    }
    const url2 = new URL(req.url ?? "/", "http://localhost");
    const download = url2.searchParams.get("download") === "1";
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      ...(download ? { "Content-Disposition": 'attachment; filename=".env"' } : {}),
      "Cache-Control": "no-store",
    });
    res.end(readFileSync(envFile));
    return;
  }

  if (method === "POST" && pathname === "/api/config") {
    // Guardar la config elegida en el panel (data/ui-config.json): variables
    // planas de IA/publicación/canales + conectores globales + asignación por
    // canal. Se recarga la config (con detección de IA local) y se aplica en vivo.
    const vars: UiConfigVars = {};
    for (const k of UI_CONFIG_KEYS) {
      const v = json[k];
      if (typeof v === "string") vars[k] = v;
    }
    saveUiConfig(config.root, vars);
    // Conectores de IA (globales) y qué conector usa cada canal.
    if (Array.isArray(json.connectors)) {
      saveConnectors(config.root, json.connectors as ConnectorConfig[]);
    }
    if (json.channelLlm && typeof json.channelLlm === "object") {
      saveChannelLlm(config.root, json.channelLlm as Partial<Record<ChannelId, string>>);
    }
    applyUiConfig(config.root, true);
    const fresh = loadConfig(config.root);
    await applyLocalLlm(fresh, () => {}); // silencioso: el panel ya muestra el resultado
    applyFreshConfig(runtime, fresh);
    const out = configView(fresh, loadUiConfig(fresh.root));
    const test = json.test === true ? await testLlmConnection(fresh) : undefined;
    return sendJson(res, 200, { ok: true, config: out, test });
  }

  // ── Chat con el agente: conversación persistente con la IA elegida ──
  if (method === "GET" && pathname === "/api/chat") {
    return sendJson(res, 200, {
      messages: loadChat(config.root),
      connectors: Object.values(loadConnectors(config.root)),
      llm: { provider: config.llm.provider, baseUrl: config.llm.baseUrl, model: config.llm.model, speed: config.llm.speed },
    });
  }

  if (method === "POST" && pathname === "/api/chat/clear") {
    saveChat(config.root, []);
    return sendJson(res, 200, { ok: true });
  }

  if (method === "POST" && pathname === "/api/chat") {
    const message = typeof json.message === "string" ? json.message.trim() : "";
    if (!message) return sendJson(res, 400, { error: "Escribe un mensaje." });
    const connectorId = typeof json.connectorId === "string" ? json.connectorId : "";
    const chatStore = new Store(config.dataFile);
    const history = loadChat(config.root);
    const userEntry: ChatEntry = { role: "user", content: message, at: new Date().toISOString() };
    const messages = [...history, userEntry].slice(-40);
    try {
      const opts = chatLlmOptions(config, connectorId);
      const llmMessages = [
        { role: "system" as const, content: chatSystemPrompt(config, chatStore) },
        ...messages.slice(-20).map((m) => ({ role: m.role, content: m.content })),
      ];
      const answer = await chat(opts, llmMessages, 1);
      // Órdenes ejecutables: si el agente responde con un JSON de acción al
      // final, el panel lo ejecuta de verdad (generar, programar, publicación).
      const cmd = extractChatAction(answer);
      const executed = cmd ? await runChatAction(runtime, cmd) : null;
      const updated = [
        ...messages,
        { role: "assistant" as const, content: answer, at: new Date().toISOString(), executed },
      ].slice(-40);
      saveChat(config.root, updated);
      return sendJson(res, 200, {
        ok: true,
        messages: updated,
        llm: { provider: opts.provider, baseUrl: opts.baseUrl, model: opts.model, speed: opts.speed },
        executed,
      });
    } catch (err) {
      // El mensaje del usuario queda guardado para no perder el hilo; la
      // respuesta fallida se reintenta desde el panel.
      saveChat(config.root, messages);
      return sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Chat con streaming (SSE): el panel muestra el texto mientras el agente
  // escribe. Cada fragmento llega como data:{"delta":"…"} y al final se envía
  // data:{"done":true,"messages":[…],"executed":…} (las órdenes se ejecutan
  // igual que en POST /api/chat). POST /api/chat se mantiene para no-stream.
  if (method === "POST" && pathname === "/api/chat/stream") {
    const message = typeof json.message === "string" ? json.message.trim() : "";
    if (!message) return sendJson(res, 400, { error: "Escribe un mensaje." });
    const connectorId = typeof json.connectorId === "string" ? json.connectorId : "";
    const chatStore = new Store(config.dataFile);
    const history = loadChat(config.root);
    const userEntry: ChatEntry = { role: "user", content: message, at: new Date().toISOString() };
    const messages = [...history, userEntry].slice(-40);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (obj: unknown): void => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        /* cliente desconectado */
      }
    };
    // Si el cliente se va, aborta la petición al LLM (libera el servidor).
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const opts = chatLlmOptions(config, connectorId);
      opts.signal = controller.signal;
      const full = await chatStream(
        opts,
        [
          { role: "system", content: chatSystemPrompt(config, chatStore) },
          ...messages.slice(-20).map((m) => ({ role: m.role, content: m.content })),
        ],
        (delta) => send({ delta }),
      );
      const cmd = extractChatAction(full);
      const executed = cmd ? await runChatAction(runtime, cmd) : null;
      const updated = [
        ...messages,
        { role: "assistant" as const, content: full, at: new Date().toISOString(), executed },
      ].slice(-40);
      saveChat(config.root, updated);
      send({
        done: true,
        messages: updated,
        executed,
        llm: { provider: opts.provider, baseUrl: opts.baseUrl, model: opts.model, speed: opts.speed },
      });
      res.end();
    } catch (err) {
      saveChat(config.root, messages);
      send({ error: err instanceof Error ? err.message : String(err) });
      res.end();
    }
  }

  if (method === "GET" && pathname === "/api/state") {
    const items = store.contentItems.map((i) => ({ ...i, mediaName: i.filePath?.split(/[\\/]/).pop() }));
    sendJson(res, 200, {
      posts: store.posts,
      items,
      channels: (Object.keys(config.channels) as ChannelId[]).map((id) => ({
        id,
        name: PLATFORM_PROFILES[id].name,
        enabled: config.channels[id].enabled,
        limit: CHANNEL_LIMITS[id],
      })),
      dryRun: config.dryRun,
      autoPublish: config.autoPublish,
    });
    return;
  }

  if (method === "POST" && pathname === "/api/posts/approve-all") {
    const scheduled = scheduleDrafts(config, store);
    sendJson(res, 200, { ok: true, scheduled });
    return;
  }

  if (!match) {
    sendJson(res, 404, { error: "Ruta API no encontrada" });
    return;
  }

  const [, postId, action] = match;

  if (method === "PATCH" && action === "edit") {
    const patch: { text?: string; tags?: string[] } = {};
    if (typeof json.text === "string") patch.text = json.text;
    if (Array.isArray(json.tags)) patch.tags = json.tags;
    const post = store.updatePost(postId, patch);
    if (!post) return sendJson(res, 404, { error: "Post no encontrado" });
    return sendJson(res, 200, { ok: true, post });
  }

  if (method === "POST" && action === "schedule") {
    const post = scheduleSingle(config, store, postId);
    if (!post) return sendJson(res, 404, { error: "Post no encontrado" });
    return sendJson(res, 200, { ok: true, post });
  }

  if (method === "POST" && action === "publish") {
    const result = await publishSingle(config, store, postId);
    if (result === undefined) return sendJson(res, 404, { error: "Post no encontrado" });
    const post = store.getPostsByStatus("published").find((p) => p.id === postId)
      ?? store.posts.find((p) => p.id === postId);
    return sendJson(res, 200, { ok: true, result, post });
  }

  if (method === "POST" && action === "discard") {
    const removed = store.removePost(postId);
    if (!removed) return sendJson(res, 404, { error: "Post no encontrado" });
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: `Acción no soportada: ${action}` });
}

/** Vista de la config de IA para el panel (página ⚙️ y wizard de primer arranque). */
function configView(config: AgentConfig, saved: UiConfigVars): Record<string, unknown> {
  const llm = config.llm;
  const env = process.env;
  const source = saved.LLM_API_KEY ?? env.LLM_API_KEY
    ? "cloud"
    : saved.OLLAMA_BASE_URL ?? env.OLLAMA_BASE_URL
      ? "remote"
      : "auto";
  const val = (k: keyof UiConfigVars): string => saved[k] ?? env[k] ?? "";
  // Primer arranque: no hay config guardada por el panel ni IA elegida a mano.
  const firstInstall = !existsSync(uiConfigFile(config.root)) && !env.LLM_API_KEY && !env.OLLAMA_BASE_URL;
  const connectors = Object.values(loadConnectors(config.root));
  const channelAssign = loadChannelLlm(config.root);
  return {
    llm: {
      provider: llm.provider,
      baseUrl: llm.baseUrl,
      model: llm.model,
      apiKeySet: Boolean(llm.apiKey),
      localLlm: llm.localLlm,
      speed: llm.speed,
    },
    source,
    firstInstall,
    form: {
      LLM_API_KEY: val("LLM_API_KEY"),
      LLM_BASE_URL: val("LLM_BASE_URL") || "https://api.openai.com/v1",
      LLM_MODEL: val("LLM_MODEL") || "gpt-4o-mini",
      OLLAMA_BASE_URL: val("OLLAMA_BASE_URL"),
      OLLAMA_MODEL: val("OLLAMA_MODEL"),
      LLM_LOCAL: llm.localLlm,
      LLM_SPEED: llm.speed,
      DRY_RUN: val("DRY_RUN") || (config.dryRun ? "1" : "0"),
      AUTO_PUBLISH: val("AUTO_PUBLISH") || (config.autoPublish ? "1" : "0"),
    },
    publication: {
      dryRun: config.dryRun,
      autoPublish: config.autoPublish,
    },
    env: {
      path: join(config.root, ".env"),
      exists: existsSync(join(config.root, ".env")),
    },
    connectors,
    channels: (Object.keys(config.channels) as ChannelId[]).map((id) => {
      const c = config.channels[id];
      return {
        id,
        name: PLATFORM_PROFILES[id].name,
        enabled: c.enabled,
        limit: CHANNEL_LIMITS[id],
        hasCredentials: Object.values(c.credentials).some(Boolean),
        // Conector de IA asignado a este canal ("" = usa la IA global).
        llm: { connector: channelAssign[id] ?? "" },
      };
    }),
  };
}

/* ── Chat con el agente: persistencia y resolución de la IA ── */

/** Entrada del historial de chat (data/chat.json). */
interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  at: string;
  /** Orden ejecutada de verdad por el panel (solo en respuestas del agente). */
  executed?: ChatExecuted | null;
}

/** Resultado de una orden ejecutada (se muestra como chip en el chat). */
interface ChatExecuted {
  action: string;
  ok: boolean;
  label: string;
  detail?: string;
}

interface ChatActionParams {
  /** Título (o parte) del ítem sobre el que generar. */
  item?: string;
  dryRun?: boolean;
  autoPublish?: boolean;
}

interface ChatAction {
  action: string;
  params: ChatActionParams;
}

/** Órdenes que el agente puede pedir que se ejecuten (etiqueta mostrada al usuario). */
const CHAT_ACTIONS: Record<string, string> = {
  generar: "Generar drafts con IA",
  programar: "Programar pendientes",
  publicacion: "Cambiar modo de publicación",
};

function chatFile(root: string): string {
  return join(root, "data", "chat.json");
}

/** Lee el historial de chat ([] si no existe o está corrupto). */
function loadChat(root: string): ChatEntry[] {
  const file = chatFile(root);
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { messages?: unknown };
    if (!Array.isArray(data.messages)) return [];
    return data.messages.filter((m): m is ChatEntry => {
      if (typeof m !== "object" || m === null) return false;
      const role = (m as ChatEntry).role;
      return role === "user" || role === "assistant";
    });
  } catch {
    return [];
  }
}

function saveChat(root: string, messages: ChatEntry[]): void {
  const file = chatFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ messages }, null, 2) + "\n");
}

/** Opciones del LLM para el chat: el conector elegido o la IA global efectiva. */
function chatLlmOptions(config: AgentConfig, connectorId: string): LlmOptions {
  if (connectorId) {
    const c = loadConnectors(config.root)[connectorId];
    if (c) return connectorToLlmOptions(c);
  }
  const g = config.llm;
  return {
    baseUrl: g.baseUrl,
    apiKey: g.apiKey ?? "",
    model: g.model,
    provider: g.provider,
    speed: g.speed,
    temperature: 0.7,
    // El anónimo sin clave puede tardar (auto-routing); con clave, timeout normal.
    timeoutMs: g.apiKey ? 60_000 : 120_000,
  };
}

/** Convierte un conector del panel en opciones del LLM (mismo criterio que el generador). */
function connectorToLlmOptions(c: ConnectorConfig): LlmOptions {
  const speed = (["ahorro", "equilibrado", "rendimiento"] as const).includes(c.speed as LlmSpeed)
    ? (c.speed as LlmSpeed)
    : "equilibrado";
  switch (c.source) {
    case "local":
      return {
        provider: "ollama",
        baseUrl: c.baseUrl || "http://localhost:11434/v1",
        apiKey: "",
        model: c.model || "qwen2.5:7b",
        speed,
        temperature: 0.7,
        timeoutMs: 120_000,
      };
    case "remote":
      return {
        provider: "ollama",
        baseUrl: `${(c.ollamaBaseUrl || "http://localhost:11434").replace(/\/+$/, "")}/v1`,
        apiKey: "",
        model: c.ollamaModel || c.model || "qwen2.5:7b",
        speed,
        temperature: 0.7,
        timeoutMs: 120_000,
      };
    default:
      return {
        provider: c.apiKey ? "openai" : "kilo-anon",
        baseUrl: c.baseUrl || "https://api.openai.com/v1",
        apiKey: c.apiKey || "",
        model: c.model || "gpt-4o-mini",
        speed,
        temperature: 0.7,
        timeoutMs: c.apiKey ? 60_000 : 120_000,
      };
  }
}

/** Prompt de sistema del chat: rol de agente + contexto vivo del proyecto. */
function chatSystemPrompt(config: AgentConfig, store: Store): string {
  const s = store.stats();
  const channelsOn = (Object.keys(config.channels) as ChannelId[]).filter((id) => config.channels[id].enabled);
  const channelsInfo = channelsOn.length
    ? channelsOn.map((id) => `${PLATFORM_PROFILES[id].name} (${CHANNEL_LIMITS[id]} car.)`).join(", ")
    : "ninguno";
  const mode = config.autoPublish
    ? "autónomo (publica solo)"
    : config.dryRun
      ? "simulación (DRY_RUN=1)"
      : "en vivo (revisión manual)";
  return `Eres el agente de Social Agent: estratega senior de marketing y copiloto del usuario.
Estás integrado en el panel de un proyecto que ingiere ideas y media, genera publicaciones por
plataforma con IA, las deja en borradores para revisión y las programa/publica en varias redes.

ESTADO ACTUAL DEL PROYECTO (contexto vivo, úsalo y no lo inventes):
- Contenido: ${s.items} ítem(s) (ideas y media).
- Publicaciones: ${s.drafts} en borrador, ${s.scheduled} programadas, ${s.published} publicadas, ${s.failed} fallidas.
- Canales habilitados: ${channelsInfo}.
- Modo de publicación: ${mode}.
- IA en uso: ${config.llm.provider} · ${config.llm.model} (modo ${config.llm.speed}).

LÍMITES DE CARACTERES POR PLATAFORMA (respétalos en cualquier propuesta):
Mastodon 500 · Bluesky 300 · X (Twitter) 280 · LinkedIn 3000 · Instagram 2200 · Facebook 63206 · TikTok 2200.

CÓMO AYUDAR:
- Intercambiar ideas de contenido, planes editoriales (p. ej. de 30 días) y estrategia por plataforma.
- Proponer ganchos, titulares y textos respetando el límite y el tono de cada red.
- Explicar cómo funciona el proyecto o sugerir órdenes accionables.
- Cuando pidas un plan, hazlo concreto y numerado; no inventes cifras, resultados ni testimonios.
- Responde SIEMPRE en español, directo y sin relleno. Si falta contexto (negocio, oferta, público),
pregúntalo antes de inventarlo.

ÓRDENES EJECUTABLES (el panel las ejecuta de verdad):
- Si el usuario pide GENERAR drafts: responde en texto y termina con la ÚLTIMA línea:
  {"accion":"generar"}
  (para un ítem concreto por su título: {"accion":"generar","item":"<parte del título>"})
- Si pide PROGRAMAR los pendientes (aprobar borradores): termina con:
  {"accion":"programar"}
- Si pide cambiar el MODO DE PUBLICACIÓN (simulación/en vivo, autónomo/manual), termina con:
  {"accion":"publicacion","dryRun":false} y/o {"accion":"publicacion","autoPublish":true}
Reglas: explica antes en texto qué vas a ejecutar; el JSON va SIEMPRE como última línea,
sin texto ni comillas detrás. No lo emitas si la petición es solo informativa o dudosa.`;
}

/** Actualiza la config en vivo conservando las rutas del runtime (root,
 *  carpetas de contenido y dataFile): solo cambian IA, canales y modo de
 *  publicación. loadConfig() las recalcula desde env/.env; el runtime ya las
 *  tiene fijadas (p. ej. rutas de test o personalizadas). */
function applyFreshConfig(runtime: Runtime, fresh: AgentConfig): void {
  runtime.config = {
    ...runtime.config,
    dryRun: fresh.dryRun,
    autoPublish: fresh.autoPublish,
    minIntervalMs: fresh.minIntervalMs,
    llm: fresh.llm,
    channels: fresh.channels,
  };
}

/* ── Órdenes ejecutables del agente ─────────────────────────── */

/** Extrae el JSON de acción que el agente debe emitir como ÚLTIMA línea.
 *  Formato: {"accion":"generar"} · {"accion":"programar"} ·
 *  {"accion":"publicacion","dryRun":false} — tolera cercos ```json``` y
 *  texto antes, pero exige que el JSON termine la respuesta. */
function extractChatAction(raw: string): ChatAction | null {
  const clean = raw.replace(/```(?:json)?\s*([\s\S]*?)```\s*$/, "$1").trim();
  const m = clean.match(/\{\s*"accion"[\s\S]*?\}\s*$/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { accion?: unknown; item?: unknown; dryRun?: unknown; autoPublish?: unknown };
    if (typeof obj.accion !== "string") return null;
    return {
      action: obj.accion,
      params: {
        item: typeof obj.item === "string" ? obj.item : undefined,
        dryRun: typeof obj.dryRun === "boolean" ? obj.dryRun : undefined,
        autoPublish: typeof obj.autoPublish === "boolean" ? obj.autoPublish : undefined,
      },
    };
  } catch {
    return null;
  }
}

/** Ejecuta la orden del agente y devuelve el resultado (nunca lanza). */
async function runChatAction(runtime: Runtime, cmd: ChatAction): Promise<ChatExecuted> {
  const label = CHAT_ACTIONS[cmd.action];
  if (!label) {
    return {
      action: cmd.action,
      ok: false,
      label: "Acción desconocida",
      detail: `«${cmd.action}» no es una orden soportada.`,
    };
  }
  try {
    const detail = await executeChatAction(runtime, cmd);
    return { action: cmd.action, ok: true, label, detail };
  } catch (err) {
    return { action: cmd.action, ok: false, label, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Ejecuta cada orden concreta sobre la config y el store en vivo. */
async function executeChatAction(runtime: Runtime, cmd: ChatAction): Promise<string> {
  const config = runtime.config;
  const store = new Store(config.dataFile);
  switch (cmd.action) {
    case "generar": {
      let itemId: string | undefined;
      let itemTitle: string | undefined;
      if (cmd.params.item && cmd.params.item.trim()) {
        const needle = cmd.params.item.trim().toLowerCase();
        const found = store.contentItems.find((it) => it.title.toLowerCase().includes(needle));
        if (!found) throw new Error(`no encontré ningún ítem cuyo título contenga «${cmd.params.item}».`);
        itemId = found.id;
        itemTitle = found.title;
      }
      const started = startGeneration(config, itemId);
      if (!started.ok) throw new Error(started.error);
      return itemTitle
        ? `generación iniciada en segundo plano para «${itemTitle}». Sigue el progreso en la pestaña Generar.`
        : "generación iniciada en segundo plano para los ítems sin cubrir. Sigue el progreso en la pestaña Generar.";
    }
    case "programar": {
      const scheduled = scheduleDrafts(config, store);
      if (scheduled === 0) return "no había pendientes que programar.";
      return `${scheduled} draft(s) programados en horarios óptimos.`;
    }
    case "publicacion": {
      const vars: UiConfigVars = {};
      if (cmd.params.dryRun !== undefined) vars.DRY_RUN = cmd.params.dryRun ? "1" : "0";
      if (cmd.params.autoPublish !== undefined) vars.AUTO_PUBLISH = cmd.params.autoPublish ? "1" : "0";
      if (Object.keys(vars).length === 0) throw new Error("indica al menos dryRun o autoPublish.");
      saveUiConfig(config.root, vars);
      applyUiConfig(config.root, true);
      const fresh = loadConfig(config.root);
      await applyLocalLlm(fresh, () => {}); // silencioso: el panel muestra el resultado
      applyFreshConfig(runtime, fresh);
      return `modo de publicación: ${fresh.dryRun ? "simulación" : "en vivo"} + ${fresh.autoPublish ? "autónomo" : "manual"}.`;
    }
    default:
      throw new Error("acción no soportada");
  }
}

/** Prueba rápida de conexión contra la config actual (como llm:check). */
async function testLlmConnection(config: AgentConfig): Promise<{ ok: boolean; answer?: string; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const answer = await chat(
      {
        baseUrl: config.llm.baseUrl,
        apiKey: config.llm.apiKey ?? "",
        model: config.llm.model,
        temperature: 0.3,
        timeoutMs: 30_000,
        provider: config.llm.provider,
        speed: config.llm.speed,
      },
      [{ role: "user", content: "Responde solo con la palabra: ok" }],
      1,
    );
    return { ok: true, answer: answer.slice(0, 80), ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
  }
}

/** Localiza yt-dlp: tools/ del proyecto, YTDLP_PATH o el PATH del sistema. */
function findYtDlp(config: AgentConfig): string | undefined {
  const fromEnv = process.env.YTDLP_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const local = join(config.root, "tools", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  if (existsSync(local)) return local;
  return "yt-dlp"; // del PATH; si no existe, execFile reportará ENOENT
}

/** Ejecuta yt-dlp con timeout; rechaza con el último mensaje de error. */
function runYtDlp(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 600_000, maxBuffer: 5 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const tail = String(stderr || "").split(/\r?\n/).filter(Boolean).slice(-3).join(" · ");
        reject(new Error(tail || err.message));
      } else {
        resolve();
      }
    });
  });
}

function readBodyBuffer(req: import("node:http").IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function sendJson(res: import("node:http").ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
