/** Cliente LLM compatible con la API de OpenAI (Chat Completions).
 *  Funciona con OpenAI, OpenRouter, Groq, Ollama, LM Studio, etc.
 *  Solo se necesita cambiar LLM_BASE_URL y LLM_MODEL en .env.
 */

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
}

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
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
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
        Authorization: `Bearer ${opts.apiKey}`,
      },
      signal: controller?.signal,
      body: JSON.stringify({
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0.8,
        stream: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`LLM error ${res.status}: ${body.slice(0, 500)}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return await streamContent(res);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Consume una respuesta SSE de chat completions y devuelve el texto completo. */
async function streamContent(res: Response): Promise<string> {
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
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
        } else {
          // Proveedores que ignoran stream: respuesta completa en message.content.
          content = chunk.choices?.[0]?.message?.content ?? content;
        }
      } catch {
        /* línea SSE malformada: ignorar */
      }
    }
  }
  if (!content.trim()) {
    // Respuesta no-SSE (JSON plano de un proveedor que ignora stream:true).
    try {
      const full = JSON.parse(allText.trim()) as {
        choices?: { message?: { content?: string } }[];
      };
      content = full.choices?.[0]?.message?.content ?? "";
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
