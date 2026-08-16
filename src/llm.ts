/** Cliente LLM compatible con la API de OpenAI (Chat Completions).
 *  Funciona con OpenAI, OpenRouter, Groq, Ollama, LM Studio, etc.
 *  Solo se necesita cambiar LLM_BASE_URL y LLM_MODEL en .env, o dejar que
 *  applyLocalLlm() detecte una IA local/remota (Ollama, LM Studio) sola.
 */

import { cpus } from "node:os";
import type { AgentConfig, LlmSpeed } from "./config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  /** Aborta la petición tras este tiempo (ms). Útil para proveedores anónimos lentos. */
  timeoutMs?: number;
  /** Proveedor en uso ("ollama" usa la API nativa para poder cuidar el hardware). */
  provider?: string;
  /** Selector de potencia/velocidad (LLM_SPEED). */
  speed?: LlmSpeed;
}

/** Ajustes por modo de potencia/velocidad.
 *  - maxTokens:  tope de salida (evita cómputo infinito).
 *  - numCtx:     contexto (menor → menos RAM/VRAM y cómputo por token).
 *  - keepAlive:  segundos que el modelo queda cargado (menor → libera RAM antes).
 *  - threadsFactor: fracción de CPUs en modo ahorro (menos carga térmica).
 *  - modelBias:  sesgo de selección de modelo (-1 más pequeño, +1 más grande). */
export interface SpeedSettings {
  maxTokens: number;
  numCtx: number;
  keepAlive: number;
  threadsFactor?: number;
  modelBias: -1 | 0 | 1;
}

export const SPEED_SETTINGS: Record<LlmSpeed, SpeedSettings> = {
  ahorro: { maxTokens: 2048, numCtx: 6144, keepAlive: 300, threadsFactor: 0.5, modelBias: -1 },
  equilibrado: { maxTokens: 3072, numCtx: 8192, keepAlive: 1800, threadsFactor: undefined, modelBias: 0 },
  rendimiento: { maxTokens: 4096, numCtx: 16384, keepAlive: -1, threadsFactor: undefined, modelBias: 1 },
};

export async function chat(
  opts: LlmOptions,
  messages: ChatMessage[],
  attempts = 3,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await chatOnce(opts, messages);
    } catch (err) {
      lastErr = err;
      // Reintenta solo errores transitorios (red/5xx/429), no errores 4xx permanentes.
      const status = (err as { status?: number })?.status;
      const retriable = status === undefined || status === 429 || status >= 500;
      if (!retriable || attempt === attempts) throw err;
      const backoffMs = 2000 * attempt; // 2s, 4s
      console.warn(`  ⚠️  LLM error transitorio (intento ${attempt}/${attempts}). Reintentando en ${backoffMs / 1000}s…`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

async function chatOnce(opts: LlmOptions, messages: ChatMessage[]): Promise<string> {
  // Ollama: API nativa /api/chat → control real del hardware (num_ctx,
  // num_threads, keep_alive). El resto: OpenAI Chat Completions.
  const native = opts.provider === "ollama";
  const { url, body } = native ? ollamaChatRequest(opts, messages) : chatRequest(opts, messages);
  // Timeout opcional: evita que un proveedor anónimo/colgado bloquee la generación.
  const controller = opts.timeoutMs ? new AbortController() : undefined;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        const err = new Error(`LLM timeout tras ${opts.timeoutMs} ms`) as Error & { status?: number };
        err.status = 504;
        controller!.abort(err);
      }, opts.timeoutMs)
    : undefined;
  try {
    // Streaming SSE: necesario para LLM locales lentos (Ollama bufferiza la
    // respuesta completa con stream:false y supera el headersTimeout de 5 min).
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(native ? {} : { Authorization: `Bearer ${opts.apiKey}` }),
      },
      signal: controller?.signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const err = new Error(`LLM error ${res.status}: ${bodyText.slice(0, 500)}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return await streamContent(res, native ? ollamaExtract : openaiExtract);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Cuerpo OpenAI Chat Completions (no-Ollama) con max_tokens según el modo. */
export function chatRequest(
  opts: LlmOptions,
  messages: ChatMessage[],
): { url: string; body: Record<string, unknown> } {
  const speed = SPEED_SETTINGS[opts.speed ?? "equilibrado"];
  return {
    url: `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    body: {
      model: opts.model,
      messages,
      temperature: opts.temperature ?? 0.8,
      stream: true,
      max_tokens: speed.maxTokens,
    },
  };
}

/** Petición a la API NATIVA de Ollama (/api/chat): control real del hardware.
 *  - options.num_ctx: contexto (menor → menos RAM/VRAM).
 *  - options.num_predict: tope de salida.
 *  - options.num_threads: solo en modo ahorro (mitad de CPUs → menos calor).
 *  - keep_alive: segundos que el modelo queda cargado (300 ahorro, -1 rendimiento). */
export function ollamaChatRequest(
  opts: LlmOptions,
  messages: ChatMessage[],
): { url: string; body: Record<string, unknown> } {
  const speed = SPEED_SETTINGS[opts.speed ?? "equilibrado"];
  // De http://host:11434/v1 → http://host:11434/api/chat
  const base = opts.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const options: Record<string, unknown> = {
    num_ctx: speed.numCtx,
    num_predict: speed.maxTokens,
    temperature: opts.temperature ?? 0.8,
  };
  if (speed.threadsFactor !== undefined) {
    options.num_threads = Math.max(1, Math.floor(cpus().length * speed.threadsFactor));
  }
  return {
    url: `${base}/api/chat`,
    body: {
      model: opts.model,
      messages,
      stream: true,
      keep_alive: speed.keepAlive,
      options,
    },
  };
}

/** Extrae el texto de un chunk SSE de OpenAI Chat Completions. */
function openaiExtract(chunk: { choices?: { delta?: { content?: string }; message?: { content?: string } }[] }): string | undefined {
  return (
    chunk.choices?.[0]?.delta?.content ??
    // Proveedores que ignoran stream: respuesta completa en message.content.
    chunk.choices?.[0]?.message?.content
  );
}

/** Extrae el texto de un chunk SSE de la API nativa de Ollama. */
function ollamaExtract(chunk: { message?: { content?: string } }): string | undefined {
  return chunk.message?.content;
}

type ChunkExtractor = (chunk: Record<string, unknown>) => string | undefined;

/** Consume una respuesta SSE y devuelve el texto completo (con fallback a JSON plano). */
async function streamContent(res: Response, extract: ChunkExtractor): Promise<string> {
  if (!res.body) throw new Error("LLM sin cuerpo de respuesta");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let buffer = "";
  let allText = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    allText += text;
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      // SSE de OpenAI: "data: {...}" · NDJSON de Ollama nativo: "{...}" crudo.
      let payload = t;
      if (t.startsWith("data:")) {
        payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
      }
      try {
        const chunk = JSON.parse(payload) as Record<string, unknown>;
        const delta = extract(chunk);
        if (delta) content += delta;
      } catch {
        /* línea SSE/NDJSON malformada: ignorar */
      }
    }
  }
  if (!content.trim()) {
    // Respuesta no-SSE (JSON plano de un proveedor que ignora stream:true).
    try {
      const full = JSON.parse(allText.trim()) as Record<string, unknown>;
      content = extract(full) ?? "";
    } catch {
      /* no era JSON */
    }
  }
  if (!content.trim()) throw new Error("LLM devolvió respuesta vacía");
  return content.trim();
}

/** Extrae el primer bloque JSON de una respuesta LLM (tolera texto extra). */
export function extractJson<T>(raw: string): T {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No se encontró JSON en la respuesta del LLM");
  return JSON.parse(match[0]) as T;
}

/* ── Detección de IA local/remota (Ollama, LM Studio, Qwen) ─── */

export interface LocalLlmInfo {
  kind: "ollama" | "lmstudio";
  baseUrl: string;
  model: string;
}

/** Candidato a servidor: local por defecto o remoto vía OLLAMA_BASE_URL. */
export interface LlmServerCandidate {
  kind: LocalLlmInfo["kind"];
  baseUrl: string;
  /** Si el usuario ya eligió modelo (OLLAMA_MODEL): no listar, solo comprobar que responde. */
  preferModel?: string;
}

/** Servidores probados por defecto (sin configuración). */
export const LOCAL_LLM_SERVERS: LlmServerCandidate[] = [
  { kind: "ollama", baseUrl: "http://localhost:11434/v1" },
  { kind: "lmstudio", baseUrl: "http://localhost:1234/v1" },
];

/** Familias de modelos preferidas: Qwen, Llama, Gemma, Mistral, DeepSeek, Phi… */
const PREFERRED_MODEL_RE = /qwen|llama|gemma|mistral|deepseek|phi|mixtral/i;

/** Tamaño de un modelo a partir de su id ("qwen2.5:7b" → 7, "gemma3:4b" → 4). */
export function modelSize(model: string): number | undefined {
  const match = model.match(/(\d+(?:\.\d+)?)b(?=$|[-:.])/i);
  return match ? Number(match[1]) : undefined;
}

/** Elige el mejor modelo de una lista: prefiere familias conocidas y la versión ":latest".
 *  Con speed "ahorro" prefiere el más PEQUEÑO (menos RAM/VRAM/calor);
 *  con "rendimiento" el más GRANDE (más calidad/velocidad por token). */
export function pickModel(models: string[], speed: LlmSpeed = "equilibrado"): string | undefined {
  // Ignorar modelos de embeddings (no sirven para generar texto).
  const usable = models.filter((m) => !/embed|nomic|bge|snowflake/i.test(m));
  if (usable.length === 0) return undefined;
  const bias = SPEED_SETTINGS[speed].modelBias;
  const score = (m: string): number => {
    let s = 0;
    if (PREFERRED_MODEL_RE.test(m)) s += 10;
    if (/latest$/i.test(m) || !m.includes(":")) s += 5; // versión por defecto del modelo
    if (m.includes(":")) s += 1; // con tag explícito: más concreto
    const size = modelSize(m);
    if (size !== undefined && bias !== 0) {
      // ahorro: cuanto más pequeño mejor; rendimiento: cuanto más grande mejor.
      s += bias === -1 ? Math.max(0, 8 - size) : size;
    }
    return s;
  };
  return [...usable].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
}

/** Detecta una IA local/remota compatible con OpenAI (Ollama, LM Studio) consultando
 *  GET /v1/models. Prueba cada candidato hasta encontrar uno que responda con modelos. */
export async function detectLocalLlm(
  candidates: LlmServerCandidate[] = LOCAL_LLM_SERVERS,
  timeoutMs = 2000,
  speed: LlmSpeed = "equilibrado",
): Promise<LocalLlmInfo | undefined> {
  for (const server of candidates) {
    const prefer = server.preferModel;
    try {
      const res = await fetch(`${server.baseUrl.replace(/\/+$/, "")}/models`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      if (prefer) return { kind: server.kind, baseUrl: server.baseUrl, model: prefer };
      const json = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
      const models = (json.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => Boolean(id));
      const best = pickModel(models, speed);
      if (best) return { kind: server.kind, baseUrl: server.baseUrl, model: best };
    } catch {
      // servidor caído o sin respuesta: probar el siguiente
    }
  }
  return undefined;
}

/** Aplica la IA local/remota detectada a la config, si procede.
 *  - LLM_LOCAL=off   → no hace nada.
 *  - LLM_LOCAL=on    → fuerza la detección (avisa si no hay servidor).
 *  - LLM_LOCAL=auto  → detecta solo cuando no hay LLM_API_KEY configurada.
 *  Fuentes: OLLAMA_BASE_URL (máquina remota, p. ej. con Qwen) o los locales
 *  por defecto (Ollama :11434, LM Studio :1234). */
export async function applyLocalLlm(
  config: AgentConfig,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const mode = config.llm.localLlm;
  if (mode === "off") return;
  if (mode === "auto" && config.llm.apiKey) return; // la config explícita manda

  const candidates: LlmServerCandidate[] = [];
  const remote = process.env.OLLAMA_BASE_URL?.trim().replace(/\/+$/, "");
  if (remote) {
    // Acepta tanto http://host:11434 como http://host:11434/v1.
    const base = /\/v1$/.test(remote) ? remote : `${remote}/v1`;
    candidates.push({ kind: "ollama", baseUrl: base, preferModel: process.env.OLLAMA_MODEL?.trim() || undefined });
  } else {
    candidates.push(...LOCAL_LLM_SERVERS);
  }

  const local = await detectLocalLlm(candidates, 2000, config.llm.speed);
  if (!local) {
    if (mode === "on") {
      log("  ⚠️  LLM_LOCAL=1 pero no hay IA local/remota respondiendo (Ollama :11434, LM Studio :1234, u OLLAMA_BASE_URL).");
    }
    return;
  }

  config.llm.provider = local.kind;
  config.llm.baseUrl = local.baseUrl;
  config.llm.model = local.model;
  const via = remote ? `OLLAMA_BASE_URL (${remote})` : `${local.kind} (${local.baseUrl})`;
  log(`  🤖 IA local detectada: ${via} — modelo ${local.model}`);
}
