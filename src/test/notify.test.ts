import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { notifyText, sendNotifications } from "../notify.js";
import { defaultNotifyConfig, type NotifyConfig } from "../uiconfig.js";
import { testConfig } from "./helpers.js";

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

describe("Notificaciones (webhook / Telegram / Discord)", () => {
  const calls: FetchCall[] = [];
  let failWith: Error | null = null;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    calls.length = 0;
    failWith = null;
  });

  function stubFetch(): void {
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (failWith) throw failWith;
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
  }

  function cfgWith(n: Partial<NotifyConfig>) {
    const cfg = testConfig();
    cfg.notifications = { ...defaultNotifyConfig(), ...n };
    return cfg;
  }

  it("envía el aviso de publicación al webhook con el formato esperado", async () => {
    stubFetch();
    const cfg = cfgWith({ webhookUrl: "https://hooks.slack.com/services/T00" });
    await sendNotifications(cfg, { kind: "publish", channel: "mastodon", title: "Hola mundo", postUrl: "https://social.example/@x/123" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://hooks.slack.com/services/T00");
    assert.equal(calls[0].method, "POST");
    assert.match(String(calls[0].body.text), /Publicado en Mastodon: Hola mundo/);
    assert.match(String(calls[0].body.text), /https:\/\/social\.example\/@x\/123/);
    assert.equal(calls[0].body.event, "publish");
    assert.equal(calls[0].body.channel, "mastodon");
  });

  it("no avisa de publicaciones si onPublish está desactivado", async () => {
    stubFetch();
    const cfg = cfgWith({ webhookUrl: "https://hooks.slack.com/services/T00", onPublish: false });
    await sendNotifications(cfg, { kind: "publish", channel: "bluesky", title: "Hola" });
    assert.equal(calls.length, 0);
  });

  it("envía el fallo a Telegram (sendMessage) y a Discord (content)", async () => {
    stubFetch();
    const cfg = cfgWith({
      telegramToken: "123:ABC",
      telegramChatId: "-100123",
      discordUrl: "https://discord.com/api/webhooks/111",
    });
    await sendNotifications(cfg, { kind: "failure", channel: "twitter", title: "Mi post", error: "HTTP 401: token inválido" });
    assert.equal(calls.length, 2);
    const tg = calls.find((c) => c.url.startsWith("https://api.telegram.org/bot123:ABC/sendMessage"));
    assert.ok(tg, "llamada a Telegram presente");
    assert.equal(tg.body.chat_id, "-100123");
    assert.match(String(tg.body.text), /Fallo al publicar en X/);
    assert.match(String(tg.body.text), /Mi post/);
    assert.match(String(tg.body.text), /HTTP 401/);
    const dc = calls.find((c) => c.url === "https://discord.com/api/webhooks/111");
    assert.ok(dc, "llamada a Discord presente");
    assert.match(String(dc.body.content), /Fallo al publicar/);
  });

  it("no envía nada sin destinos configurados", async () => {
    stubFetch();
    const cfg = cfgWith({});
    await sendNotifications(cfg, { kind: "publish", channel: "mastodon", title: "Hola" });
    await sendNotifications(cfg, { kind: "failure", channel: "mastodon", title: "Hola", error: "boom" });
    assert.equal(calls.length, 0);
  });

  it("no avisa de fallos si onFailure está desactivado", async () => {
    stubFetch();
    const cfg = cfgWith({ webhookUrl: "https://hooks.slack.com/services/T00", onFailure: false });
    await sendNotifications(cfg, { kind: "failure", channel: "tiktok", title: "Hola", error: "boom" });
    assert.equal(calls.length, 0);
  });

  it("nunca lanza: un destino caído no rompe la publicación", async () => {
    stubFetch();
    failWith = new Error("ECONNREFUSED");
    const cfg = cfgWith({ webhookUrl: "https://hooks.slack.com/services/T00" });
    await sendNotifications(cfg, { kind: "publish", channel: "mastodon", title: "Hola" });
    assert.equal(calls.length, 0); // el fallo se loguea, no se propaga
  });

  it("recorta títulos largos en el texto del aviso", () => {
    const long = "a".repeat(200);
    const t = notifyText({ kind: "publish", channel: "instagram", title: long });
    assert.ok(t.length < long.length, "texto acotado");
    assert.match(t, /Publicado en Instagram/);
    assert.match(t, /…$/);
    const f = notifyText({ kind: "failure", channel: "facebook", title: "Título", error: "e" });
    assert.match(f, /Fallo al publicar en Facebook: Título\ne/);
  });
});
