import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { instagramAdapter } from "../channels/instagram.js";
import { tiktokAdapter } from "../channels/tiktok.js";
import type { ChannelConfig, Post } from "../types.js";

interface MockRoute {
  method: string;
  match: (url: URL) => boolean;
  handler: (req: { body: string }, url: URL) => { status: number; body: unknown };
}

/** Levanta un servidor HTTP que actúa como la API real de la plataforma. */
function mockApi(routes: MockRoute[]): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes.find((r) => r.method === (req.method ?? "GET") && r.match(url));
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "ruta no esperada" } }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const result = route.handler({ body: Buffer.concat(chunks).toString("utf8") }, url);
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function makeConfig(credentials: Record<string, string | undefined>, options: Record<string, unknown> = {}): ChannelConfig {
  return { enabled: true, credentials, options };
}

function makePost(mediaFile: string, channel: Post["channel"]): Post {
  return {
    id: `post-test-${channel}`,
    contentItemId: "item-1",
    channel,
    text: `Prueba de publicación en ${channel} con media adjunta.`,
    mediaPaths: [mediaFile],
    createdAt: new Date().toISOString(),
    status: "draft",
    attempts: 0,
  };
}

const tempMedia = join(tmpdir(), "social-agent-test-media.png");
const tempVideo = join(tmpdir(), "social-agent-test-video.mp4");

before(() => {
  writeFileSync(tempMedia, Buffer.from("fakepng"));
  writeFileSync(tempVideo, Buffer.from("fakevideo"));
});

describe("flujo real de publicación en Instagram (Graph API simulada)", () => {
  let server: Server | undefined;

  before(async () => {
    const m = await mockApi([
      {
        method: "POST",
        match: (url) => /\/1789\/media$/.test(url.pathname),
        handler: (_req, url) => {
          assert.ok(url.searchParams.get("access_token"), "envía access_token");
          assert.ok(url.searchParams.get("image_url"), "envía image_url");
          assert.ok(url.searchParams.get("caption"), "envía caption");
          return { status: 200, body: { id: "17899000000000001" } };
        },
      },
      {
        method: "GET",
        match: (url) => /^\/17899000000000001/.test(url.pathname) && url.searchParams.get("fields") === "status_code",
        handler: () => ({ status: 200, body: { status_code: "FINISHED" } }),
      },
      {
        method: "POST",
        match: (url) => /\/media_publish$/.test(url.pathname),
        handler: (_req, url) => {
          assert.equal(url.searchParams.get("creation_id"), "17899000000000001");
          return { status: 200, body: { id: "17900000000000001" } };
        },
      },
    ]);
    server = m.server;
    process.env.INSTAGRAM_GRAPH_BASE = m.base;
    process.env.INSTAGRAM_POLL_MS = "10";
  });

  it("publica imagen: crea container, espera estado y hace media_publish", async () => {
    const config = makeConfig(
      { INSTAGRAM_ACCESS_TOKEN: "tok-test", INSTAGRAM_USER_ID: "1789" },
      { mediaBaseUrl: "https://media.ejemplo.test" },
    );
    const result = await instagramAdapter.publish(makePost(tempMedia, "instagram"), config);
    assert.equal(result.ok, true, result.error);
    assert.match(result.url ?? "", /^https:\/\/www\.instagram\.com\/p\//);
  });

  it("devuelve error claro si faltan credenciales", async () => {
    const result = await instagramAdapter.publish(makePost(tempMedia, "instagram"), makeConfig({}));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Faltan credenciales/);
  });

  after(() => {
    server?.close();
    delete process.env.INSTAGRAM_GRAPH_BASE;
    delete process.env.INSTAGRAM_POLL_MS;
  });
});

describe("flujo real de publicación en TikTok (API simulada)", () => {
  let server: Server | undefined;

  before(async () => {
    const m = await mockApi([
      {
        method: "POST",
        match: (url) => url.pathname.endsWith("/post/publish/video/init/"),
        handler: () => ({ status: 200, body: { data: { publish_id: "publish-123" } } }),
      },
      {
        method: "POST",
        match: (url) => url.pathname.endsWith("/post/publish/status/fetch/"),
        handler: (_req, url) => {
          assert.equal(url.searchParams.get("publish_id"), "publish-123");
          return { status: 200, body: { data: { status: "PUBLISH_COMPLETE" } } };
        },
      },
    ]);
    server = m.server;
    process.env.TIKTOK_API_BASE = m.base;
    process.env.TIKTOK_POLL_MS = "10";
    process.env.TIKTOK_MEDIA_BASE_URL = "https://media.ejemplo.test";
  });

  it("publica video (modo PULL): init → consulta de estado → completo", async () => {
    const config = makeConfig({ TIKTOK_ACCESS_TOKEN: "tok-test", TIKTOK_OPEN_ID: "open-1" });
    const result = await tiktokAdapter.publish(makePost(tempVideo, "tiktok"), config);
    assert.equal(result.ok, true, result.error);
  });

  it("devuelve error claro sin credenciales", async () => {
    const result = await tiktokAdapter.publish(makePost(tempVideo, "tiktok"), makeConfig({}));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Faltan credenciales/);
  });

  after(() => {
    server?.close();
    delete process.env.TIKTOK_API_BASE;
    delete process.env.TIKTOK_POLL_MS;
    delete process.env.TIKTOK_MEDIA_BASE_URL;
  });
});

describe("TikTok en modo PUSH (con upload_url)", () => {
  let server: Server | undefined;

  before(async () => {
    const m = await mockApi([
      {
        method: "POST",
        match: (url) => url.pathname.endsWith("/post/publish/video/init/"),
        handler: () => ({ status: 200, body: { data: { publish_id: "p-2", upload_url: "http://127.0.0.1:1/upload" } } }),
      },
      {
        method: "POST",
        match: (url) => url.pathname.endsWith("/post/publish/status/fetch/"),
        handler: () => ({ status: 200, body: { data: { status: "PUBLISH_COMPLETE" } } }),
      },
    ]);
    server = m.server;
    process.env.TIKTOK_API_BASE = m.base;
    process.env.TIKTOK_POLL_MS = "10";
    process.env.TIKTOK_MEDIA_BASE_URL = "https://media.ejemplo.test";
  });

  it("intenta subir el video al upload_url devuelto por la API", async () => {
    const config = makeConfig({ TIKTOK_ACCESS_TOKEN: "tok-test", TIKTOK_OPEN_ID: "open-1" });
    const result = await tiktokAdapter.publish(makePost(tempVideo, "tiktok"), config);
    // El PUT va a un puerto cerrado → la API devuelve error claro, nunca lanza.
    assert.equal(result.ok, false);
    assert.ok(result.error && result.error.length > 0, "debe devolver un mensaje de error");
  });

  after(() => {
    server?.close();
    delete process.env.TIKTOK_API_BASE;
    delete process.env.TIKTOK_POLL_MS;
    delete process.env.TIKTOK_MEDIA_BASE_URL;
  });
});
