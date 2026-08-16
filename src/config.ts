import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChannelConfig, ChannelId, ContentItem } from "./types.js";
import { CHANNELS } from "./types.js";

/** Carga .env manualmente (sin dependencias externas). */
export function loadEnvFile(root = process.cwd()): void {
  const envPath = resolve(root, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Quitar comillas envolventes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export type LocalLlmMode = "auto" | "on" | "off";

/** Selector de potencia/velocidad para la IA local (LLM_SPEED).
 *  - ahorro: menos RAM/VRAM/CPU (contexto corto, modelo pequeño, descarga rápida).
 *  - equilibrado: compromiso por defecto.
 *  - rendimiento: máxima velocidad (contexto amplio, modelo grande, siempre cargado). */
export type LlmSpeed = "ahorro" | "equilibrado" | "rendimiento";

export interface AgentConfig {
  root: string;
  contentDir: string;
  ideasDir: string;
  mediaDir: string;
  dataFile: string;
  /** Modo autónomo: publica sin aprobación humana. */
  autoPublish: boolean;
  /** Publicar en seco: no toca APIs reales. */
  dryRun: boolean;
  /** Intervalo mínimo entre publicaciones (ms). */
  minIntervalMs: number;
  llm: {
    provider: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
    /** Fallback a plantillas si no hay API key. */
    enabled: boolean;
    /** Detección de IA local/remota (LLM_LOCAL): "auto" | "on" | "off". */
    localLlm: LocalLlmMode;
    /** Selector de potencia/velocidad (LLM_SPEED): ahorro | equilibrado | rendimiento. */
    speed: LlmSpeed;
  };
  channels: Record<ChannelId, ChannelConfig>;
}

const CHANNEL_CREDENTIAL_KEYS: Record<ChannelId, string[]> = {
  mastodon: ["MASTODON_URL", "MASTODON_TOKEN"],
  bluesky: ["BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD"],
  twitter: ["TWITTER_API_KEY", "TWITTER_API_SECRET", "TWITTER_ACCESS_TOKEN", "TWITTER_ACCESS_SECRET"],
  linkedin: ["LINKEDIN_ACCESS_TOKEN", "LINKEDIN_ORG_ID"],
  instagram: ["INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_USER_ID"],
  facebook: ["FACEBOOK_ACCESS_TOKEN", "FACEBOOK_PAGE_ID"],
  tiktok: ["TIKTOK_ACCESS_TOKEN", "TIKTOK_OPEN_ID"],
};

export function loadConfig(root = process.cwd()): AgentConfig {
  loadEnvFile(root);
  const channels = {} as Record<ChannelId, ChannelConfig>;
  for (const id of CHANNELS) {
    const creds: Record<string, string | undefined> = {};
    for (const key of CHANNEL_CREDENTIAL_KEYS[id]) creds[key] = process.env[key];
    const hasCredentials = Object.values(creds).some(Boolean);
    const enabledEnv = process.env[`CHANNEL_${id.toUpperCase()}_ENABLED`];
    const enabled = enabledEnv ? enabledEnv === "1" || enabledEnv === "true" : hasCredentials;
    channels[id] = {
      enabled,
      credentials: creds,
      options: {
        // Opciones por canal leídas del entorno (p.ej. visibilidad).
        visibility: process.env[`CHANNEL_${id.toUpperCase()}_VISIBILITY`] ?? undefined,
      },
    };
  }

  const dryRun = (process.env.DRY_RUN ?? "1") === "1" || (process.env.DRY_RUN ?? "1") === "true";

  // Comunicación con la IA. Prioridad:
  //   1. LLM_API_KEY → el proveedor configurado (OpenRouter, Gemini, Groq, Ollama…).
  //   2. Sin key, con LLM_FREE_FALLBACK!=0 (default) → proveedor gratuito anónimo
  //      (Kilo Code, sin registro ni tarjeta; auto-routing a modelos :free).
  //   3. LLM_ENABLED=0 → plantillas, sin llamadas externas.
  const apiKey = process.env.LLM_API_KEY;
  const explicitDisable = (process.env.LLM_ENABLED ?? "1") === "0";
  const freeFallback = (process.env.LLM_FREE_FALLBACK ?? "1") !== "0";
  const enabled = !explicitDisable && (Boolean(apiKey) || freeFallback);
  const isFreeAnonymous = enabled && !apiKey;

  // Modo de detección de IA local/remota (LLM_LOCAL): auto (default), on, off.
  const localRaw = (process.env.LLM_LOCAL ?? "auto").toLowerCase();
  const localLlm: LocalLlmMode =
    localRaw === "0" || localRaw === "off" || localRaw === "false"
      ? "off"
      : localRaw === "1" || localRaw === "on" || localRaw === "true" || localRaw === "force"
        ? "on"
        : "auto";

  // Selector de potencia/velocidad (LLM_SPEED): ahorro | equilibrado | rendimiento.
  const speedRaw = (process.env.LLM_SPEED ?? "equilibrado").toLowerCase();
  const speed: LlmSpeed =
    speedRaw === "ahorro" || speedRaw === "eco"
      ? "ahorro"
      : speedRaw === "rendimiento" || speedRaw === "turbo" || speedRaw === "fast"
        ? "rendimiento"
        : "equilibrado";

  return {
    root,
    contentDir: resolve(root, process.env.CONTENT_DIR ?? "content"),
    ideasDir: resolve(root, process.env.IDEAS_DIR ?? "content/ideas"),
    mediaDir: resolve(root, process.env.MEDIA_DIR ?? "content/media"),
    dataFile: resolve(root, process.env.DATA_FILE ?? "data/agent.json"),
    autoPublish: (process.env.AUTO_PUBLISH ?? "0") === "1" || (process.env.AUTO_PUBLISH ?? "0") === "true",
    dryRun,
    minIntervalMs: Number(process.env.MIN_POST_INTERVAL_MINUTES ?? 60) * 60_000,
    llm: {
      provider: isFreeAnonymous
        ? "kilo-anon"
        : (process.env.LLM_PROVIDER ?? "openai"),
      baseUrl: isFreeAnonymous
        ? "https://api.kilo.ai/api/gateway"
        : (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1"),
      apiKey,
      model: isFreeAnonymous ? "openrouter/free" : (process.env.LLM_MODEL ?? "gpt-4o-mini"),
      enabled,
      localLlm,
      speed,
    },
    channels,
  };
}

export const CONTENT_EXTENSIONS = [
  // Imágenes
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".bmp",
  // Videos
  ".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v",
  // Audio
  ".mp3", ".wav", ".m4a", ".ogg",
];

export function mediaTypeOf(file: string): ContentItem["mediaType"] {
  const ext = file.toLowerCase();
  if ([/\.jpe?g$/, /\.png$/, /\.gif$/, /\.webp$/, /\.heic$/, /\.bmp$/].some((r) => r.test(ext)))
    return "photo";
  if ([/\.mp4$/, /\.mov$/, /\.webm$/, /\.mkv$/, /\.avi$/, /\.m4v$/].some((r) => r.test(ext)))
    return "video";
  if ([/\.mp3$/, /\.wav$/, /\.m4a$/, /\.ogg$/].some((r) => r.test(ext))) return "audio";
  return "text";
}
