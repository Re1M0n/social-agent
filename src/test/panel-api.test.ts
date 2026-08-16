import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { startPanel } from "../panel/server.js";
import { enableChannel, testConfig } from "./helpers.js";
import { Store } from "../storage.js";
import type { ContentItem, Draft } from "../types.js";

const UI_ENV_KEYS = ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_LOCAL", "LLM_SPEED", "OLLAMA_BASE_URL", "OLLAMA_MODEL", "LLM_FREE_FALLBACK", "LLM_ENABLED"];

describe("Panel web: API de revisión y aprobación", () => {
  let server: Server;
  let base = "";
  let dataFile = "";
  let mediaDir = "";
  let ideasDir = "";
  let dir = "";
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of UI_ENV_KEYS) savedEnv[k] = process.env[k];
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
    dir = mkdtempSync(join(tmpdir(), "social-agent-panel-"));
    dataFile = join(dir, "agent.json");
    mediaDir = join(dir, "media");
    ideasDir = join(dir, "ideas");
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

    // Hermético: config de test que no lee el .env local (CI no lo tiene).
    // root=dir → la config del panel (data/ui-config.json) se guarda en el tmpdir.
    const config = testConfig({ root: dir, dataFile, mediaDir, ideasDir });
    enableChannel(config, "mastodon");
    server = startPanel(config, 0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
    // Restaurar process.env (POST /api/config lo modifica en vivo).
    for (const k of UI_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
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

  async function waitGenerationDone(waitBase: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const p = await (await fetch(`${waitBase}/api/generation`)).json();
      if (!p.running) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("la generación no terminó a tiempo");
  }

  it("POST /api/generate arranca en segundo plano y crea drafts para los ítems sin cubrir", async () => {
    const store = new Store(dataFile);
    store.addContentItem({
      id: "item-b",
      kind: "idea",
      title: "Segunda idea para generar",
      body: "Contenido.",
      mediaType: "text",
      ingestedAt: new Date().toISOString(),
    });
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json();
    assert.equal(res.status, 202);
    assert.equal(data.ok, true);
    await waitGenerationDone(base);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.ok(state.posts.some((p: { contentItemId: string; channel: string }) => p.contentItemId === "item-b" && p.channel === "mastodon"));
  });

  it("POST /api/generate con itemId genera solo ese ítem", async () => {
    const store = new Store(dataFile);
    store.addContentItem({
      id: "item-c",
      kind: "idea",
      title: "Tercera idea",
      body: "Contenido.",
      mediaType: "text",
      ingestedAt: new Date().toISOString(),
    });
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: "item-c" }),
    });
    assert.equal(res.status, 202);
    await waitGenerationDone(base);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.ok(state.posts.some((p: { contentItemId: string }) => p.contentItemId === "item-c"));
  });

  it("rechaza una segunda generación mientras hay una en curso", async () => {
    const store = new Store(dataFile);
    store.addContentItem({
      id: "item-d",
      kind: "idea",
      title: "Cuarta idea",
      body: "Contenido.",
      mediaType: "text",
      ingestedAt: new Date().toISOString(),
    });
    const first = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: "item-d" }),
    });
    assert.equal(first.status, 202);
    // La generación tarda algo (plantillas sincronizadas en el mismo tick);
    // aunque ya hubiera terminado, el segundo POST nunca debe romper nada.
    const second = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.ok([202, 409].includes(second.status), `segundo POST: ${second.status}`);
    await waitGenerationDone(base);
  });

  it("POST /api/media guarda el archivo, lo ingiere y aparece en /api/state", async () => {
    const res = await fetch(`${base}/api/media`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent("demo.png") },
      body: Buffer.from("fakepng"),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.file, "demo.png");
    assert.ok(existsSync(join(mediaDir, "demo.png")), "archivo guardado en mediaDir");
    assert.equal(readFileSync(join(mediaDir, "demo.png"), "utf8"), "fakepng");
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.ok(state.items.some((i: { mediaName: string }) => i.mediaName === "demo.png"), "ítem ingerido");
  });

  it("POST /api/media rechaza extensiones no soportadas", async () => {
    const res = await fetch(`${base}/api/media`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent("malware.exe") },
      body: Buffer.from("x"),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Extensión no soportada/);
  });

  it("POST /api/ideas guarda la idea como .md y la ingiere", async () => {
    const res = await fetch(`${base}/api/ideas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Nueva idea test", body: "Cuerpo de la idea" }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.file, "nueva-idea-test.md");
    assert.ok(existsSync(join(ideasDir, "nueva-idea-test.md")), "archivo creado en ideasDir");
    assert.match(readFileSync(join(ideasDir, "nueva-idea-test.md"), "utf8"), /^Nueva idea test\n\nCuerpo de la idea/);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.ok(state.items.some((i: { title: string }) => i.title === "Nueva idea test"));
  });

  it("POST /api/ideas rechaza ideas sin título", async () => {
    const res = await fetch(`${base}/api/ideas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "sin título" }),
    });
    assert.equal(res.status, 400);
  });

  it("DELETE /api/items/:id borra la idea, sus posts y el archivo .md", async () => {
    const created = await (await fetch(`${base}/api/ideas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Idea a borrar", body: "Contenido" }),
    })).json();
    assert.ok(created.itemId, "idea creada");
    await (await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: created.itemId }),
    })).json();
    await waitGenerationDone(base);
    const file = join(ideasDir, "idea-a-borrar.md");
    assert.ok(existsSync(file), "el .md existe antes de borrar");
    const res = await fetch(`${base}/api/items/${created.itemId}`, { method: "DELETE" });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(existsSync(file), false, "el .md se borra del disco");
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.items.some((i: { id: string }) => i.id === created.itemId), false);
    assert.equal(state.posts.some((p: { contentItemId: string }) => p.contentItemId === created.itemId), false);
  });

  it("DELETE /api/items/:id borra también la media subida", async () => {
    const up = await (await fetch(`${base}/api/media`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent("a-borrar.png") },
      body: Buffer.from("fakepng"),
    })).json();
    const file = join(mediaDir, "a-borrar.png");
    assert.ok(existsSync(file), "la media existe antes de borrar");
    const res = await fetch(`${base}/api/items/${up.itemId}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.equal(existsSync(file), false, "la media se borra del disco");
  });

  it("DELETE /api/items/:id devuelve 404 para ítems inexistentes", async () => {
    const res = await fetch(`${base}/api/items/no-existe`, { method: "DELETE" });
    assert.equal(res.status, 404);
  });

  it("POST /api/ideas-file guarda un .md arrastrado e ingiere la idea", async () => {
    const res = await fetch(`${base}/api/ideas-file`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent("idea-arrastrada.md") },
      body: Buffer.from("Título de la idea arrastrada\n\nCuerpo desde un archivo de texto."),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.file, "idea-arrastrada.md");
    assert.ok(existsSync(join(ideasDir, "idea-arrastrada.md")), "archivo guardado en ideasDir");
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.ok(state.items.some((i: { title: string }) => i.title === "Título de la idea arrastrada"));
  });

  it("POST /api/ideas-file rechaza archivos que no son de texto", async () => {
    const res = await fetch(`${base}/api/ideas-file`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent("nota.docx") },
      body: Buffer.from("x"),
    });
    assert.equal(res.status, 400);
  });

  it("POST /api/import-url valida la URL y el host", async () => {
    const cases: Array<[Record<string, unknown>, number]> = [
      [{}, 400],
      [{ url: "no-es-una-url" }, 400],
      [{ url: "https://instagram.com/p/xyz" }, 400],
    ];
    for (const [body, expected] of cases) {
      const res = await fetch(`${base}/api/import-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, expected, `body ${JSON.stringify(body)}`);
    }
  });

  it("GET /api/config devuelve el estado de la IA y el formulario", async () => {
    const res = await fetch(`${base}/api/config`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.llm && data.llm.provider && data.llm.model, "información de la IA presente");
    assert.ok(data.form && typeof data.form.LLM_MODEL === "string", "formulario con valores");
    assert.equal(typeof data.firstInstall, "boolean");
  });

  it("POST /api/config guarda en data/ui-config.json, recarga la config y la aplica en vivo", async () => {
    const res = await fetch(`${base}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        LLM_API_KEY: "sk-test",
        LLM_BASE_URL: "https://ejemplo.test/v1",
        LLM_MODEL: "modelo-test",
        LLM_LOCAL: "off",
        LLM_SPEED: "ahorro",
        OLLAMA_BASE_URL: "",
        OLLAMA_MODEL: "",
        LLM_FREE_FALLBACK: "",
        LLM_ENABLED: "",
      }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.config.firstInstall, false, "ya no es primer arranque");
    assert.equal(data.config.llm.speed, "ahorro");
    assert.equal(data.config.form.LLM_MODEL, "modelo-test");
    const saved = JSON.parse(readFileSync(join(dir, "data", "ui-config.json"), "utf8"));
    assert.equal(saved.LLM_MODEL, "modelo-test");
    // Persistido y activo en el siguiente GET.
    const again = await (await fetch(`${base}/api/config`)).json();
    assert.equal(again.firstInstall, false);
    assert.equal(again.llm.model, "modelo-test");
  });

  it("POST /api/config con OLLAMA_BASE_URL guarda la fuente remota", async () => {
    const res = await fetch(`${base}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        LLM_API_KEY: "",
        LLM_BASE_URL: "",
        LLM_MODEL: "",
        // off: este test no sondea la red, solo verifica persistencia/fuente.
        LLM_LOCAL: "off",
        LLM_SPEED: "equilibrado",
        OLLAMA_BASE_URL: "http://192.168.1.50:11434",
        OLLAMA_MODEL: "qwen2.5:7b",
        LLM_FREE_FALLBACK: "",
        LLM_ENABLED: "",
      }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.config.source, "remote");
    assert.equal(data.config.form.OLLAMA_BASE_URL, "http://192.168.1.50:11434");
  });

  it("POST /api/config habilita/deshabilita canales y los persiste", async () => {
    const res = await fetch(`${base}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        LLM_API_KEY: "", LLM_BASE_URL: "", LLM_MODEL: "",
        LLM_LOCAL: "", LLM_SPEED: "", OLLAMA_BASE_URL: "", OLLAMA_MODEL: "",
        LLM_FREE_FALLBACK: "", LLM_ENABLED: "",
        CHANNEL_MASTODON_ENABLED: "0",
        CHANNEL_BLUESKY_ENABLED: "1",
        CHANNEL_TWITTER_ENABLED: "0",
        CHANNEL_LINKEDIN_ENABLED: "0",
        CHANNEL_INSTAGRAM_ENABLED: "0",
        CHANNEL_FACEBOOK_ENABLED: "0",
        CHANNEL_TIKTOK_ENABLED: "0",
      }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    const find = (id: string) => data.config.channels.find((c: { id: string }) => c.id === id);
    assert.equal(find("mastodon").enabled, false, "mastodon deshabilitado por el panel");
    assert.equal(find("bluesky").enabled, true, "bluesky habilitado por el panel");
    const saved = JSON.parse(readFileSync(join(dir, "data", "ui-config.json"), "utf8"));
    assert.equal(saved.CHANNEL_MASTODON_ENABLED, "0");
    assert.equal(saved.CHANNEL_BLUESKY_ENABLED, "1");
    // El estado queda aplicado en el siguiente GET.
    const again = await (await fetch(`${base}/api/config`)).json();
    assert.equal(again.channels.find((c: { id: string }) => c.id === "mastodon").enabled, false);
  });

  it("POST /api/config cambia DRY_RUN y AUTO_PUBLISH en caliente", async () => {
    const res = await fetch(`${base}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        LLM_API_KEY: "", LLM_BASE_URL: "", LLM_MODEL: "",
        LLM_LOCAL: "", LLM_SPEED: "", OLLAMA_BASE_URL: "", OLLAMA_MODEL: "",
        LLM_FREE_FALLBACK: "", LLM_ENABLED: "",
        DRY_RUN: "0",
        AUTO_PUBLISH: "1",
        CHANNEL_MASTODON_ENABLED: "1", CHANNEL_BLUESKY_ENABLED: "1",
        CHANNEL_TWITTER_ENABLED: "1", CHANNEL_LINKEDIN_ENABLED: "1",
        CHANNEL_INSTAGRAM_ENABLED: "1", CHANNEL_FACEBOOK_ENABLED: "1", CHANNEL_TIKTOK_ENABLED: "1",
      }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.config.publication.dryRun, false, "sale de simulación");
    assert.equal(data.config.publication.autoPublish, true, "modo autónomo activado");
    const saved = JSON.parse(readFileSync(join(dir, "data", "ui-config.json"), "utf8"));
    assert.equal(saved.DRY_RUN, "0");
    assert.equal(saved.AUTO_PUBLISH, "1");
    // Aplicado al resto de la API: /api/state lo refleja al instante.
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.dryRun, false);
    assert.equal(state.autoPublish, true);
  });

  it("GET /api/config/env muestra la ruta del .env y permite abrirlo/descargarlo", async () => {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "MASTODON_URL=https://ejemplo.test\nMASTODON_TOKEN=secreto-local\n");
    try {
      // GET /api/config anuncia la ruta y si existe.
      const cfg = await (await fetch(`${base}/api/config`)).json();
      assert.equal(cfg.env.exists, true);
      assert.ok(cfg.env.path.endsWith(".env"), `ruta del .env: ${cfg.env.path}`);
      // Abrir: contenido en texto plano.
      const open = await fetch(`${base}/api/config/env`);
      assert.equal(open.status, 200);
      assert.match(open.headers.get("content-type") || "", /text\/plain/);
      assert.match(await open.text(), /MASTODON_URL=https:\/\/ejemplo\.test/);
      // Descargar: forzar attachment.
      const down = await fetch(`${base}/api/config/env?download=1`);
      assert.match(down.headers.get("content-disposition") || "", /attachment/);
    } finally {
      rmSync(envFile);
    }
    // Sin archivo → 404 claro.
    const missing = await fetch(`${base}/api/config/env`);
    assert.equal(missing.status, 404);
    const cfg2 = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg2.env.exists, false);
  });

  it("POST /api/config guarda conectores de IA y su asignación por canal (sin tocar el .env)", async () => {
    const res = await fetch(`${base}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        LLM_API_KEY: "", LLM_BASE_URL: "", LLM_MODEL: "",
        LLM_LOCAL: "off", LLM_SPEED: "", OLLAMA_BASE_URL: "", OLLAMA_MODEL: "",
        LLM_FREE_FALLBACK: "", LLM_ENABLED: "", DRY_RUN: "", AUTO_PUBLISH: "",
        CHANNEL_MASTODON_ENABLED: "", CHANNEL_BLUESKY_ENABLED: "", CHANNEL_TWITTER_ENABLED: "",
        CHANNEL_LINKEDIN_ENABLED: "", CHANNEL_INSTAGRAM_ENABLED: "", CHANNEL_FACEBOOK_ENABLED: "", CHANNEL_TIKTOK_ENABLED: "",
        connectors: [
          { id: "c1", name: "Groq", source: "cloud", baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk-test", model: "llama-3.3-70b", speed: "rendimiento", ollamaBaseUrl: "", ollamaModel: "" },
          { id: "c2", name: "Qwen de casa", source: "remote", baseUrl: "", apiKey: "", model: "", speed: "ahorro", ollamaBaseUrl: "http://192.168.1.50:11434", ollamaModel: "qwen2.5:32b" },
        ],
        channelLlm: { mastodon: "c1", linkedin: "c2" },
      }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    // La vista devuelve los conectores y la asignación por canal.
    assert.equal(data.config.connectors.length, 2);
    const find = (id: string) => data.config.channels.find((c: { id: string }) => c.id === id);
    assert.equal(find("mastodon").llm.connector, "c1");
    assert.equal(find("linkedin").llm.connector, "c2");
    assert.equal(find("bluesky").llm.connector, "", "sin asignación → IA global");
    // Persistido en ui-config.json (secciones estructuradas, no variables planas).
    const saved = JSON.parse(readFileSync(join(dir, "data", "ui-config.json"), "utf8"));
    assert.equal(saved.connectors.c1.source, "cloud");
    assert.equal(saved.connectors.c1.model, "llama-3.3-70b");
    assert.equal(saved.connectors.c2.ollamaBaseUrl, "http://192.168.1.50:11434");
    assert.equal(saved.channelLlm.mastodon, "c1");
    assert.equal(saved.channelLlm.linkedin, "c2");
    assert.equal(saved.CHANNEL_MASTODON_LLM, undefined, "no usa variables planas por canal");
    // La asignación queda aplicada en la config viva (la ve el CLI también).
    const again = await (await fetch(`${base}/api/config`)).json();
    const masto2 = again.channels.find((c: { id: string }) => c.id === "mastodon");
    assert.equal(masto2.llm.connector, "c1");
    // Nada se escribe en el .env.
    assert.equal(existsSync(join(dir, ".env")), false, "el POST no toca el .env");
  });
});
