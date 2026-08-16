import { createReadStream } from "node:fs";
import { basename } from "node:path";
import type { PublishResult } from "./types.js";

/** Sube un archivo como multipart/form-data usando fetch nativo. */
export async function uploadMultipart(
  url: string,
  filePath: string,
  token: string | undefined,
  fieldName = "file",
  extraFields: Record<string, string> = {},
): Promise<Response> {
  const boundary = `----social-agent-${Date.now().toString(36)}`;
  const file = createReadStream(filePath);
  const chunks: Buffer[] = [];
  for await (const chunk of file) chunks.push(chunk as Buffer);
  const fileData = Buffer.concat(chunks);
  const mime = mimeOf(filePath);

  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(extraFields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${basename(filePath)}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    fileData,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  const body = Buffer.concat(parts);

  const headers: Record<string, string> = {
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  return fetch(url, { method: "POST", headers, body });
}

export function mimeOf(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".m4v")) return "video/x-m4v";
  if (lower.endsWith(".avi")) return "video/x-msvideo";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "application/octet-stream";
}

/** Convierte una respuesta HTTP en PublishResult legible. */
export async function toResult(res: Response, okUrl?: (json: any) => string | undefined): Promise<PublishResult> {
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* no json */
  }
  if (res.ok || res.status === 200 || res.status === 201 || res.status === 202) {
    return { ok: true, url: okUrl?.(json) ?? json?.url ?? json?.data?.url ?? json?.data?.uri };
  }
  const detail =
    json?.error_description ?? json?.error?.message ?? json?.message ?? text.slice(0, 300);
  return { ok: false, error: `HTTP ${res.status}: ${detail}` };
}
