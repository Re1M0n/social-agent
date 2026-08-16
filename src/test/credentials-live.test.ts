import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { blueskyAdapter } from "../channels/bluesky.js";
import { mastodonAdapter } from "../channels/mastodon.js";
import { checkChannelCredentials } from "../metrics.js";
import type { ChannelConfig, Post } from "../types.js";

/** Mock minimalista de API: responde JSON por ruta. */
function mockApi(
  routes: { method: string; path: RegExp; status?: number; body: unknown; requireAuth?: boolean }[],
): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes.find((r) => r.method === (req.method ?? "GET") && r.path.test(url.pathname));
    const auth = req.headers.authorization ?? "";
    if (route?.requireAuth && !auth.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "ruta no esperada" } }));
      return;
    }
    res.writeHead(route.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(route.body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function makeConfig(credentials: Record<string, string | undefined>): ChannelConfig {
  return { enabled: true, credentials, options: {} };
}

function makePost(channel: Post["channel"]): Post {
  return {
    id: `post-live-${channel}`,
    contentItemId: "item-1",
    channel,
    text: `Publicación de prueba en vivo para ${channel} — Social Agent.`,
    createdAt: new Date().toISOString(),
    status: "draft",
    attempts: 0,
  };
}

describe("verificación de credenciales en vivo (checkChannelCredentials)", () => {
  let server: Server | undefined;
  const original = { xrpc: process.env.BLUESKY_XRPC };

  before(async () => {
    const m = await mockApi([
      {
        method: "GET",
        path: /\/api\/v1\/accounts\/verify_credentials/,
        requireAuth: true,
        body: { username: "tester", followers_count: 42 },
      },
      {
        method: "POST",
        path: /\/com\.atproto\.server\.createSession/,
        body: { accessJwt: "jwt-123", did: "did:plc:abc" },
      },
      {
        method: "GET",
        path: /\/app\.bsky\.actor\.getProfile/,
        requireAuth: true,
        body: { displayName: "Test Blue", followersCount: 7 },
      },
    ]);
    server = m.server;
    process.env.BLUESKY_XRPC = m.base;
  });

  it("mastodon: credenciales válidas → ok con cuenta y seguidores", async () => {
    const cfg = makeConfig({ MASTODON_URL: "http://127.0.0.1:1", MASTODON_TOKEN: "tok" });
    // Redirigir al mock: sobreescribimos la URL de la instancia con la del mock.
    cfg.credentials.MASTODON_URL = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const r = await checkChannelCredentials("mastodon", cfg);
    assert.equal(r.ok, true, r.detail);
    assert.match(r.detail, /tester/);
    assert.match(r.detail, /42/);
  });

  it("mastodon: sin credenciales → error claro", async () => {
    const r = await checkChannelCredentials("mastodon", makeConfig({}));
    assert.equal(r.ok, false);
    assert.match(r.detail, /MASTODON/);
  });

  it("mastodon: token inválido → HTTP 401", async () => {
    const cfg = makeConfig({ MASTODON_URL: "http://127.0.0.1:1", MASTODON_TOKEN: "bad" });
    cfg.credentials.MASTODON_URL = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    cfg.credentials.MASTODON_TOKEN = ""; // auth vacío → el mock responde 401
    const r = await checkChannelCredentials("mastodon", cfg);
    assert.equal(r.ok, false);
  });

  it("bluesky: credenciales válidas → ok con nombre y seguidores", async () => {
    const cfg = makeConfig({ BLUESKY_HANDLE: "test.bsky.social", BLUESKY_APP_PASSWORD: "pass" });
    const r = await checkChannelCredentials("bluesky", cfg);
    assert.equal(r.ok, true, r.detail);
    assert.match(r.detail, /Test Blue/);
    assert.match(r.detail, /7/);
  });

  it("bluesky: sin credenciales → error claro", async () => {
    const r = await checkChannelCredentials("bluesky", makeConfig({}));
    assert.equal(r.ok, false);
    assert.match(r.detail, /BLUESKY/);
  });

  it("otros canales → aviso sin verificación en vivo", async () => {
    const r = await checkChannelCredentials("instagram", makeConfig({}));
    assert.equal(r.ok, false);
    assert.match(r.detail, /manual/);
  });

  after(() => {
    server?.close();
    if (original.xrpc === undefined) delete process.env.BLUESKY_XRPC;
    else process.env.BLUESKY_XRPC = original.xrpc;
  });
});

describe("flujo real de publicación en Mastodon (API v1 simulada)", () => {
  let server: Server | undefined;

  before(async () => {
    const m = await mockApi([
      {
        method: "POST",
        path: /\/api\/v1\/statuses/,
        requireAuth: true,
        body: { url: "https://mastodon.social/@tester/1234567890" },
      },
    ]);
    server = m.server;
  });

  it("publica status y devuelve la URL", async () => {
    const cfg = makeConfig({
      MASTODON_URL: `http://127.0.0.1:${(server!.address() as { port: number }).port}`,
      MASTODON_TOKEN: "tok",
    });
    const result = await mastodonAdapter.publish(makePost("mastodon"), cfg);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.url, "https://mastodon.social/@tester/1234567890");
  });

  it("devuelve error claro si faltan credenciales", async () => {
    const result = await mastodonAdapter.publish(makePost("mastodon"), makeConfig({}));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /MASTODON/);
  });

  after(() => server?.close());
});

describe("flujo real de publicación en Bluesky (AT Protocol simulado)", () => {
  let server: Server | undefined;
  const original = { xrpc: process.env.BLUESKY_XRPC };

  before(async () => {
    const m = await mockApi([
      {
        method: "POST",
        path: /\/com\.atproto\.server\.createSession/,
        body: { accessJwt: "jwt-123", did: "did:plc:abc" },
      },
      {
        method: "POST",
        path: /\/com\.atproto\.repo\.createRecord/,
        requireAuth: true,
        body: { uri: "at://did:plc:abc/app.bsky.feed.post/3abc" },
      },
    ]);
    server = m.server;
    process.env.BLUESKY_XRPC = m.base;
  });

  it("crea sesión, publica el registro y construye la URL amigable", async () => {
    const cfg = makeConfig({ BLUESKY_HANDLE: "test.bsky.social", BLUESKY_APP_PASSWORD: "pass" });
    const result = await blueskyAdapter.publish(makePost("bluesky"), cfg);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.url, "https://bsky.app/profile/did:plc:abc/post/3abc");
  });

  it("devuelve error claro sin credenciales", async () => {
    const result = await blueskyAdapter.publish(makePost("bluesky"), makeConfig({}));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /BLUESKY/);
  });

  after(() => {
    server?.close();
    if (original.xrpc === undefined) delete process.env.BLUESKY_XRPC;
    else process.env.BLUESKY_XRPC = original.xrpc;
  });
});
