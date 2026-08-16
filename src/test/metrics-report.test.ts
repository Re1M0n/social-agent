import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { generateWeeklyReport, type WeeklyReportContext } from "../agent/marketingAgent.js";
import { loadConfig } from "../config.js";
import { bskyUriFromUrl, fetchFollowers, fetchPostEngagement } from "../metrics.js";
import type { ChannelConfig, Post } from "../types.js";

function mockApi(routes: Array<{ method: string; match: (url: URL) => boolean; handler: () => { status: number; body: unknown } }>): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes.find((r) => r.method === (req.method ?? "GET") && r.match(url));
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
      return;
    }
    const result = route.handler();
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}` });
    });
  });
}

function makeConfig(credentials: Record<string, string | undefined>): ChannelConfig {
  return { enabled: true, credentials, options: {} };
}

function makePublishedPost(channel: Post["channel"], url: string): Post {
  return {
    id: `post-m-${channel}`,
    contentItemId: "item-1",
    channel,
    text: "Un post de prueba para métricas.",
    createdAt: new Date().toISOString(),
    status: "published",
    publishedAt: new Date().toISOString(),
    postUrl: url,
    attempts: 1,
  };
}

describe("bskyUriFromUrl", () => {
  it("convierte la URL amigable en AT-URI", () => {
    assert.equal(
      bskyUriFromUrl("https://bsky.app/profile/did:plc:abc123/post/3kxyz"),
      "at://did:plc:abc123/app.bsky.feed.post/3kxyz",
    );
  });
  it("devuelve undefined para URLs que no son de Bluesky", () => {
    assert.equal(bskyUriFromUrl("https://x.com/i/status/123"), undefined);
    assert.equal(bskyUriFromUrl(undefined), undefined);
  });
});

describe("fetchFollowers y fetchPostEngagement (APIs simuladas)", () => {
  let mastodon: Server | undefined;
  let bluesky: Server | undefined;

  before(async () => {
    const m = await mockApi([
      {
        method: "GET",
        match: (url) => url.pathname.endsWith("/accounts/verify_credentials"),
        handler: () => ({ status: 200, body: { followers_count: 1234 } }),
      },
      {
        method: "GET",
        match: (url) => url.pathname.endsWith("/statuses/42"),
        handler: () => ({
          status: 200,
          body: { favourites_count: 15, reblogs_count: 7, replies_count: 3 },
        }),
      },
    ]);
    mastodon = m.server;
    process.env.MASTODON_URL = m.base;

    const b = await mockApi([
      {
        method: "POST",
        match: (url) => url.pathname.endsWith("/com.atproto.server.createSession"),
        handler: () => ({ status: 200, body: { accessJwt: "jwt" } }),
      },
      {
        method: "GET",
        match: (url) => url.pathname.endsWith("/app.bsky.actor.getProfile"),
        handler: () => ({ status: 200, body: { followersCount: 5678 } }),
      },
      {
        method: "GET",
        match: (url) => url.pathname.endsWith("/app.bsky.feed.getPostThread"),
        handler: () => ({
          status: 200,
          body: { thread: { post: { likeCount: 22, repostCount: 9, replyCount: 4 } } },
        }),
      },
    ]);
    bluesky = b.server;
    process.env.BLUESKY_XRPC = b.base;
  });

  it("obtiene seguidores de Mastodon", async () => {
    const cfg = makeConfig({ MASTODON_URL: process.env.MASTODON_URL, MASTODON_TOKEN: "tok" });
    assert.equal(await fetchFollowers("mastodon", cfg), 1234);
  });

  it("obtiene engagement de un status de Mastodon", async () => {
    const cfg = makeConfig({ MASTODON_URL: process.env.MASTODON_URL, MASTODON_TOKEN: "tok" });
    const post = makePublishedPost("mastodon", `${process.env.MASTODON_URL}/@usuario/42`);
    const eng = await fetchPostEngagement(post, cfg);
    assert.deepEqual(eng, { likes: 15, reposts: 7, comments: 3 });
  });

  it("obtiene seguidores y engagement de Bluesky", async () => {
    const cfg = makeConfig({ BLUESKY_HANDLE: "usuario.bsky.social", BLUESKY_APP_PASSWORD: "pw" });
    assert.equal(await fetchFollowers("bluesky", cfg), 5678);
    const post = makePublishedPost(
      "bluesky",
      "https://bsky.app/profile/did:plc:abc/post/3kxyz",
    );
    const eng = await fetchPostEngagement(post, cfg);
    assert.deepEqual(eng, { likes: 22, reposts: 9, comments: 4 });
  });

  it("devuelve undefined para canales sin API accesible", async () => {
    assert.equal(await fetchFollowers("instagram", makeConfig({})), undefined);
    assert.equal(await fetchPostEngagement(makePublishedPost("twitter", "https://x.com/i/status/1"), makeConfig({})), undefined);
  });

  after(() => {
    mastodon?.close();
    bluesky?.close();
    delete process.env.MASTODON_URL;
    delete process.env.BLUESKY_XRPC;
  });
});

describe("generateWeeklyReport (plantilla)", () => {
  const ctx: WeeklyReportContext = {
    weekStart: "2026-08-10",
    weekEnd: "2026-08-16",
    posts: [
      {
        channel: "mastodon",
        text: "Lanzamos nuestra app de productividad",
        publishedAt: "2026-08-11T09:00:00Z",
        likes: 40,
        reposts: 12,
        comments: 5,
      },
      {
        channel: "bluesky",
        text: "Cómo empezar en LinkedIn sin impostor",
        publishedAt: "2026-08-12T10:00:00Z",
        likes: 8,
        reposts: 2,
        comments: 1,
      },
    ],
    followers: { mastodon: { count: 1200, fetchedAt: "2026-08-14T00:00:00Z" } },
    channelsEnabled: ["mastodon", "bluesky"],
  };

  it("genera un informe estructurado con secciones clave", async () => {
    const config = loadConfig();
    config.llm.enabled = false;
    const { report, usedLlm } = await generateWeeklyReport(config, ctx);
    assert.equal(usedLlm, false);
    for (const section of ["Resumen ejecutivo", "Rendimiento por canal", "Mejor contenido", "Insights"]) {
      assert.ok(report.includes(section), `falta sección: ${section}`);
    }
    assert.ok(report.includes("40"), "incluye likes totales");
    assert.ok(report.includes("| mastodon |"), "tabla por canal");
  });

  it("marca el mejor contenido de la semana", async () => {
    const config = loadConfig();
    config.llm.enabled = false;
    const { report } = await generateWeeklyReport(config, ctx);
    assert.ok(report.includes("Lanzamos nuestra app"), "mejor post identificado");
  });
});
