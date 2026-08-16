import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../config.js";
import {
  chatRequest,
  detectLocalLlm,
  groupChannelsByLlm,
  llmForChannel,
  modelSize,
  ollamaChatRequest,
  pickModel,
  SPEED_SETTINGS,
  type LlmServerCandidate,
} from "../llm.js";
import { testConfig } from "./helpers.js";

const MSG = [{ role: "user" as const, content: "hola" }];

/** Mock minimalista de servidor LLM: responde JSON por ruta. */
function mockLlm(routes: { path: string; status?: number; body: unknown }[]): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes.find((r) => url.pathname === r.path);
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "ruta no esperada" }));
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

describe("pickModel", () => {
  it("prefiere familias conocidas (Qwen, Llama, Gemma, Mistral…) sobre otras", () => {
    assert.equal(pickModel(["mistral:7b", "gpt-4o"]), "mistral:7b");
    assert.equal(pickModel(["gpt-4o", "dolphin-llama3:8b"]), "dolphin-llama3:8b");
    assert.equal(pickModel(["qwen2.5:7b", "gpt-4o"]), "qwen2.5:7b");
  });

  it("prefiere la versión :latest dentro de la misma familia", () => {
    assert.equal(pickModel(["qwen2.5:7b", "qwen2.5:latest"]), "qwen2.5:latest");
  });

  it("ignora modelos de embeddings (no sirven para generar texto)", () => {
    assert.equal(pickModel(["nomic-embed-text:latest", "qwen2.5:7b"]), "qwen2.5:7b");
    assert.equal(pickModel(["nomic-embed-text:latest"]), undefined);
  });

  it("devuelve undefined con lista vacía", () => {
    assert.equal(pickModel([]), undefined);
  });

  it("ahorro prefiere el modelo más pequeño de la misma familia", () => {
    assert.equal(pickModel(["qwen2.5:7b", "qwen2.5:3b", "qwen2.5:14b"], "ahorro"), "qwen2.5:3b");
  });

  it("rendimiento prefiere el modelo más grande de la misma familia", () => {
    assert.equal(pickModel(["qwen2.5:7b", "qwen2.5:3b", "qwen2.5:14b"], "rendimiento"), "qwen2.5:14b");
  });

  it("equilibrado mantiene el orden por familia/versión sin sesgo de tamaño", () => {
    assert.equal(pickModel(["qwen2.5:7b", "qwen2.5:14b"], "equilibrado"), "qwen2.5:14b");
  });
});

describe("IA por canal (llmForChannel / groupChannelsByLlm)", () => {
  const base = () => testConfig({});

  it("sin override usa la IA global", () => {
    const cfg = base();
    const llm = llmForChannel(cfg, "mastodon");
    assert.equal(llm.provider, cfg.llm.provider);
    assert.equal(llm.model, cfg.llm.model);
    assert.equal(llm.speed, cfg.llm.speed);
  });

  it("cloud por canal: usa su clave/endpoint/modelo", () => {
    const cfg = base();
    cfg.llm.channels.mastodon = {
      source: "cloud",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "gsk-test",
      model: "llama-3.3-70b",
      speed: "rendimiento",
    };
    const llm = llmForChannel(cfg, "mastodon");
    assert.equal(llm.provider, "openai");
    assert.equal(llm.baseUrl, "https://api.groq.com/openai/v1");
    assert.equal(llm.apiKey, "gsk-test");
    assert.equal(llm.model, "llama-3.3-70b");
    assert.equal(llm.speed, "rendimiento");
    // Otro canal sin override sigue con la global.
    assert.equal(llmForChannel(cfg, "bluesky").provider, cfg.llm.provider);
  });

  it("remote por canal: apunta a la máquina con Qwen (host + /v1)", () => {
    const cfg = base();
    cfg.llm.channels.linkedin = { source: "remote", ollamaBaseUrl: "http://192.168.1.50:11434", ollamaModel: "qwen2.5:32b", speed: "ahorro" };
    const llm = llmForChannel(cfg, "linkedin");
    assert.equal(llm.provider, "ollama");
    assert.equal(llm.baseUrl, "http://192.168.1.50:11434/v1");
    assert.equal(llm.model, "qwen2.5:32b");
    assert.equal(llm.speed, "ahorro");
  });

  it("local por canal con IA global en la nube: usa localhost", () => {
    const cfg = base();
    cfg.llm.channels.instagram = { source: "local", model: "qwen2.5:7b" };
    const llm = llmForChannel(cfg, "instagram");
    assert.equal(llm.provider, "ollama");
    assert.equal(llm.baseUrl, "http://localhost:11434/v1");
    assert.equal(llm.model, "qwen2.5:7b");
  });

  it("agrupa canales por IA efectiva: los del mismo grupo comparten llamada", () => {
    const cfg = base();
    cfg.llm.channels.mastodon = { source: "cloud", apiKey: "k1", baseUrl: "https://x/v1", model: "m1" };
    cfg.llm.channels.bluesky = { source: "cloud", apiKey: "k1", baseUrl: "https://x/v1", model: "m1" };
    cfg.llm.channels.twitter = { source: "cloud", apiKey: "k2", baseUrl: "https://x/v1", model: "m1" };
    const groups = groupChannelsByLlm(cfg, ["mastodon", "bluesky", "twitter", "linkedin"]);
    assert.equal(groups.length, 3, `grupos: ${JSON.stringify(groups.map((g) => g.channels))}`);
    const masto = groups.find((g) => g.channels.includes("mastodon"));
    assert.ok(masto!.channels.includes("bluesky"), "mastodon y bluesky comparten IA → misma llamada");
    const tw = groups.find((g) => g.channels.includes("twitter"));
    assert.equal(tw!.channels.length, 1, "twitter tiene IA distinta → llamada aparte");
  });
});

describe("conectores globales (data/ui-config.json → config.llm.channels)", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "sg-conn-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(
      join(dir, "data", "ui-config.json"),
      JSON.stringify({
        connectors: {
          c1: { name: "Groq", source: "cloud", baseUrl: "https://api.groq.com/openai/v1", apiKey: "k-test", model: "llama-3.3-70b", speed: "rendimiento" },
          c2: { name: "Qwen de casa", source: "remote", ollamaBaseUrl: "http://192.168.1.50:11434", ollamaModel: "qwen2.5:32b", speed: "ahorro" },
        },
        channelLlm: { mastodon: "c1", linkedin: "c2" },
      }),
    );
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("loadConfig resuelve la IA de cada canal desde su conector asignado", () => {
    const cfg = loadConfig(dir);
    const masto = cfg.llm.channels.mastodon;
    assert.equal(masto?.source, "cloud");
    assert.equal(masto?.apiKey, "k-test");
    assert.equal(masto?.model, "llama-3.3-70b");
    assert.equal(masto?.speed, "rendimiento");
    const li = cfg.llm.channels.linkedin;
    assert.equal(li?.source, "remote");
    assert.equal(li?.ollamaBaseUrl, "http://192.168.1.50:11434");
    assert.equal(li?.ollamaModel, "qwen2.5:32b");
    assert.equal(cfg.llm.channels.bluesky, undefined, "sin asignación → IA global");
    // llmForChannel lo usa directamente para generar.
    assert.equal(llmForChannel(cfg, "mastodon").model, "llama-3.3-70b");
    assert.equal(llmForChannel(cfg, "linkedin").provider, "ollama");
    assert.equal(llmForChannel(cfg, "linkedin").baseUrl, "http://192.168.1.50:11434/v1");
    assert.equal(llmForChannel(cfg, "linkedin").speed, "ahorro");
  });

  it("un conector inexistente o sin asignación cae a la IA global", () => {
    const cfg = loadConfig(dir);
    assert.equal(cfg.llm.channels.bluesky, undefined);
    assert.equal(llmForChannel(cfg, "bluesky").provider, cfg.llm.provider);
  });
});

describe("modelSize", () => {
  it("extrae el tamaño de distintos ids", () => {
    assert.equal(modelSize("qwen2.5:7b"), 7);
    assert.equal(modelSize("qwen2.5:7b-q4_K_M"), 7);
    assert.equal(modelSize("gemma3:4b"), 4);
    assert.equal(modelSize("llama3.1:8b"), 8);
    assert.equal(modelSize("gpt-4o"), undefined);
    assert.equal(modelSize("nomic-embed-text:latest"), undefined);
  });
});

describe("selector de potencia/velocidad (chatRequest / ollamaChatRequest)", () => {
  const base = { baseUrl: "http://host:11434/v1", apiKey: "", model: "qwen2.5:7b" };

  it("OpenAI: incluye max_tokens según el modo", () => {
    const { url, body } = chatRequest({ ...base, speed: "ahorro" }, MSG);
    assert.match(url, /\/chat\/completions$/);
    assert.equal(body.max_tokens, SPEED_SETTINGS.ahorro.maxTokens);
    assert.equal(body.options, undefined);
  });

  it("Ollama nativo: URL /api/chat y opciones de hardware en todos los modos", () => {
    const { url, body } = ollamaChatRequest({ ...base, speed: "rendimiento" }, MSG);
    assert.match(url, /\/api\/chat$/);
    const options = body.options as Record<string, unknown>;
    assert.equal(options.num_ctx, SPEED_SETTINGS.rendimiento.numCtx);
    assert.equal(options.num_predict, SPEED_SETTINGS.rendimiento.maxTokens);
    assert.equal(body.keep_alive, -1); // nunca descarga el modelo
    assert.equal(options.num_threads, undefined); // rendimiento: sin límite
  });

  it("Ollama ahorro: mitad de CPUs y descarga del modelo a los 5 min", () => {
    const { body } = ollamaChatRequest({ ...base, speed: "ahorro" }, MSG);
    const options = body.options as Record<string, unknown>;
    assert.equal(body.keep_alive, 300);
    assert.equal(options.num_ctx, SPEED_SETTINGS.ahorro.numCtx);
    assert.equal(options.num_threads, Math.max(1, Math.floor(cpus().length * 0.5)));
  });

  it("los modos tienen ajustes crecientes: ahorro < equilibrado < rendimiento", () => {
    assert.ok(SPEED_SETTINGS.ahorro.maxTokens < SPEED_SETTINGS.equilibrado.maxTokens);
    assert.ok(SPEED_SETTINGS.equilibrado.maxTokens < SPEED_SETTINGS.rendimiento.maxTokens);
    assert.ok(SPEED_SETTINGS.ahorro.numCtx < SPEED_SETTINGS.equilibrado.numCtx);
    assert.ok(SPEED_SETTINGS.equilibrado.numCtx < SPEED_SETTINGS.rendimiento.numCtx);
  });
});

describe("detectLocalLlm", () => {
  let server: Server | undefined;
  let base = "";

  before(async () => {
    const m = await mockLlm([
      {
        path: "/v1/models",
        body: { data: [{ id: "qwen2.5:7b" }, { id: "nomic-embed-text:latest" }] },
      },
    ]);
    server = m.server;
    base = m.base;
  });

  it("detecta el servidor y elige el mejor modelo (Qwen primero)", async () => {
    const local = await detectLocalLlm([{ kind: "ollama", baseUrl: `${base}/v1` }], 500);
    assert.ok(local);
    assert.equal(local.kind, "ollama");
    assert.equal(local.model, "qwen2.5:7b");
  });

  it("responde 404 o sin modelos → no detecta", async () => {
    const local = await detectLocalLlm([{ kind: "ollama", baseUrl: `${base}/v2` }], 500);
    assert.equal(local, undefined);
  });

  it("preferModel: usa el modelo elegido por el usuario sin listar", async () => {
    const local = await detectLocalLlm(
      [{ kind: "ollama", baseUrl: `${base}/v1`, preferModel: "qwen2.5:32b" }],
      500,
    );
    assert.ok(local);
    assert.equal(local.model, "qwen2.5:32b");
  });

  it("salta servidores sin modelos útiles y sigue con el siguiente", async () => {
    const empty = await mockLlm([{ path: "/v1/models", body: { data: [{ id: "nomic-embed-text:latest" }] } }]);
    try {
      const candidates: LlmServerCandidate[] = [
        { kind: "lmstudio", baseUrl: `${empty.base}/v1` },
        { kind: "ollama", baseUrl: `${base}/v1` },
      ];
      const local = await detectLocalLlm(candidates, 500);
      assert.ok(local);
      assert.equal(local.kind, "ollama");
      assert.equal(local.model, "qwen2.5:7b");
    } finally {
      empty.server.close();
    }
  });

  it("servidor caído (puerto cerrado) → no detecta", async () => {
    const local = await detectLocalLlm([{ kind: "ollama", baseUrl: "http://127.0.0.1:1/v1" }], 500);
    assert.equal(local, undefined);
  });

  after(() => server?.close());
});
