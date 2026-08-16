import { readFileSync, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_PROFILES } from "../agent/marketingAgent.js";
import { mimeOf } from "../channels/http.js";
import type { AgentConfig } from "../config.js";
import { CHANNEL_LIMITS, publishSingle, scheduleDrafts, scheduleSingle } from "../publisher.js";
import { Store } from "../storage.js";
import type { ChannelId } from "../types.js";

/** Ruta del HTML del panel: se lee en runtime desde src (sin paso de build). */
function panelHtmlPath(config: AgentConfig): string {
  const fromSrc = join(config.root, "src", "panel", "index.html");
  if (existsSync(fromSrc)) return fromSrc;
  return join(fileURLToPath(new URL(".", import.meta.url)), "index.html");
}

/** Arranca el panel web. Devuelve el servidor (útil para tests con puerto 0). */
export function startPanel(config: AgentConfig, port: number): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      await route(config, req.method ?? "GET", url.pathname, req, res);
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
  config: AgentConfig,
  method: string,
  pathname: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
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
    await handleApi(config, method, pathname, req, res);
    return;
  }

  sendJson(res, 404, { error: "Ruta no encontrada" });
}

async function handleApi(
  config: AgentConfig,
  method: string,
  pathname: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  // El store se carga fresco en cada petición para ver cambios externos.
  const store = new Store(config.dataFile);
  const body = await readBody(req);
  const json = body ? JSON.parse(body) : {};
  const match = pathname.match(/^\/api\/posts\/([^/]+)\/([a-z-]+)$/);

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

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function sendJson(res: import("node:http").ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
