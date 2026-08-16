import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Genera una imagen con APIs gratuitas:
 *  - Con HF_TOKEN: Hugging Face Inference (FLUX.1-schnell).
 *  - Sin clave: Pollinations (image.pollinations.ai, sin registro).
 *  Devuelve la ruta del archivo guardado.
 */
export async function generateImage(
  prompt: string,
  outFile: string,
  hfToken?: string,
): Promise<string> {
  const res = hfToken
    ? await generateWithHf(prompt, hfToken)
    : await generateWithPollinations(prompt);

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Generación de imagen falló (HTTP ${res.status}): ${detail.slice(0, 200)}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) {
    throw new Error(`La API devolvió un archivo sospechosamente pequeño (${bytes.length} bytes).`);
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, bytes);
  return outFile;
}

/** Pollinations: gratis, sin clave. URL con el prompt en el path. */
async function generateWithPollinations(prompt: string): Promise<Response> {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux`;
  return fetch(url, { method: "GET", signal: AbortSignal.timeout(60_000) });
}

/** Hugging Face Inference Providers (requiere HF_TOKEN gratis). FLUX.1-schnell. */
async function generateWithHf(prompt: string, token: string): Promise<Response> {
  return fetch(
    "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-wait-for-model": "true",
      },
      body: JSON.stringify({ inputs: prompt }),
      signal: AbortSignal.timeout(120_000),
    },
  );
}
