import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_PROFILES } from "../agent/marketingAgent.js";
import { mimeOf } from "../channels/http.js";
import { CONTENT_EXTENSIONS, loadConfig, type AgentConfig } from "../config.js";
import { generateForAll, generateForItem, type GenerationProgress } from "../generator.js";
import { ingest } from "../ingest.js";
import { applyLocalLlm, chat } from "../llm.js";
import { CHANNEL_LIMITS, publishSingle, scheduleDrafts, scheduleSingle } from "../publisher.js";
import { Store } from "../storage.js";
import type { ChannelId } from "../types.js";
import { applyUiConfig, loadUiConfig, saveUiConfig, uiConfigFile, UI_CONFIG_KEYS, type UiConfigVars } from "../uiconfig.js";

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
    if (generation?.running) return sendJson(res, 409, { error: "Ya hay una generación en curso. Espera a que termine." });
    const itemId = typeof json.itemId === "string" ? json.itemId : undefined;
    const startedAt = Date.now();
    generation = { running: true, currentItem: undefined, index: 0, total: 0, generated: 0, startedAt };
    const update = (p: GenerationProgress): void => {
      if (generation) Object.assign(generation, p);
    };
    const genStore = new Store(config.dataFile);
    const run = itemId
      ? generateForItem(config, genStore, itemId, update)
      : generateForAll(config, genStore, update);
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

  if (method === "POST" && pathname === "/api/config") {
    // Guardar las variables de IA elegidas en el panel (data/ui-config.json),
    // recargar la config (con detección de IA local) y aplicarla en vivo.
    const vars: UiConfigVars = {};
    for (const k of UI_CONFIG_KEYS) {
      const v = json[k];
      if (typeof v === "string") vars[k] = v;
    }
    saveUiConfig(config.root, vars);
    applyUiConfig(config.root, true);
    const fresh = loadConfig(config.root);
    await applyLocalLlm(fresh, () => {}); // silencioso: el panel ya muestra el resultado
    runtime.config = fresh;
    const out = configView(fresh, loadUiConfig(fresh.root));
    const test = json.test === true ? await testLlmConnection(fresh) : undefined;
    return sendJson(res, 200, { ok: true, config: out, test });
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
    },
  };
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
