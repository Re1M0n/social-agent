import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { startPanel } from "../panel/server.js";
import { Store } from "../storage.js";
import type { ContentItem, Draft } from "../types.js";

describe("Panel web: API de revisión y aprobación", () => {
  let server: Server;
  let base = "";
  let dataFile = "";
  const drafts: Draft[] = [
    {
      id: "post-a-mastodon",
      contentItemId: "item-a",
      channel: "mastodon",
      text: "Borrador de prueba en Mastodon.",
      tags: ["prueba"],
      createdAt: new Date().toISOString(),
    },
    {
      id: "post-a-twitter",
      contentItemId: "item-a",
      channel: "twitter",
      text: "Borrador para X con #hashtag.",
      tags: ["prueba"],
      createdAt: new Date().toISOString(),
    },
  ];

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "social-agent-panel-"));
    dataFile = join(dir, "agent.json");
    const store = new Store(dataFile);
    const item: ContentItem = {
      id: "item-a",
      kind: "idea",
      title: "Idea de prueba",
      body: "Contenido base.",
      mediaType: "text",
      ingestedAt: new Date().toISOString(),
    };
    store.addContentItem(item);
    store.addDrafts(drafts);

    const config = loadConfig();
    config.dataFile = dataFile;
    server = startPanel(config, 0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(join(tmpdir(), "social-agent-panel-"), { recursive: true, force: true });
  });

  it("GET / sirve el panel HTML", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Social Agent · Panel de revisión/);
  });

  it("GET /api/state devuelve posts, ítems y canales con límites", async () => {
    const res = await fetch(`${base}/api/state`);
    const data = await res.json();
    assert.equal(data.posts.length, 2);
    assert.equal(data.items[0].id, "item-a");
    const twitter = data.channels.find((c: { id: string }) => c.id === "twitter");
    assert.equal(twitter.limit, 280);
  });

  it("PATCH /api/posts/:id/edit actualiza el texto", async () => {
    const res = await fetch(`${base}/api/posts/post-a-mastodon/edit`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Texto editado desde el panel." }),
    });
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.post.text, "Texto editado desde el panel.");
  });

  it("POST /api/posts/:id/schedule aprueba y programa en horario óptimo", async () => {
    const res = await fetch(`${base}/api/posts/post-a-twitter/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.post.status, "scheduled");
    assert.ok(data.post.scheduledFor, "tiene fecha programada");
    assert.ok(Date.parse(data.post.scheduledFor) > Date.now() - 60_000);
  });

  it("POST /api/posts/:id/publish publica el post (dry-run)", async () => {
    const res = await fetch(`${base}/api/posts/post-a-mastodon/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json();
    assert.equal(data.result, "published");
    assert.equal(data.post.status, "published");
  });

  it("POST /api/posts/:id/discard elimina el draft", async () => {
    const res = await fetch(`${base}/api/posts/post-a-twitter/discard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal((await res.json()).ok, true);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.posts.some((p: { id: string }) => p.id === "post-a-twitter"), false);
  });

  it("devuelve 404 para rutas inexistentes", async () => {
    const res = await fetch(`${base}/api/posts/nope/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 404);
  });
});
