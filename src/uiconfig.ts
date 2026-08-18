import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CHANNELS, type ChannelId } from "./types.js";

/** Variables de IA, canales y modo de publicación editables desde el panel web
 *  (se guardan en data/ui-config.json y se aplican a process.env al arrancar). */
export const UI_CONFIG_KEYS = [
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_LOCAL",
  "LLM_SPEED",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "LLM_FREE_FALLBACK",
  "LLM_ENABLED",
  // Modo de publicación: DRY_RUN (simulación) y AUTO_PUBLISH (autónomo).
  "DRY_RUN",
  "AUTO_PUBLISH",
  // Canales: CHANNEL_<CANAL>_ENABLED = "1" (fuerza activo) / "0" (fuerza inactivo).
  ...CHANNELS.map((id) => `CHANNEL_${id.toUpperCase()}_ENABLED` as const),
] as const;

export type UiConfigKey = (typeof UI_CONFIG_KEYS)[number];
export type UiConfigVars = Partial<Record<UiConfigKey, string>>;

/** Un conector de IA definido globalmente (local, Qwen remoto, API en la nube…). */
export interface ConnectorConfig {
  id: string;
  name: string;
  /** local = Ollama/LM Studio · remote = otra máquina con Ollama (Qwen) · cloud = API con clave. */
  source: "local" | "remote" | "cloud";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  speed?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

/** Ruta del archivo de config del panel (junto a data/agent.json). */
export function uiConfigFile(root: string): string {
  return join(root, "data", "ui-config.json");
}

/** Lee el JSON completo del archivo de config del panel ({} si no existe/corrupto). */
function readUiConfigFile(root: string): Record<string, unknown> {
  const file = uiConfigFile(root);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeUiConfigFile(root: string, data: Record<string, unknown>): void {
  const file = uiConfigFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** Lee las variables planas guardadas por el panel ({} si no existe). */
export function loadUiConfig(root: string): UiConfigVars {
  const data = readUiConfigFile(root);
  const out: UiConfigVars = {};
  for (const k of UI_CONFIG_KEYS) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

/** Guarda las variables planas del panel: mezcla con lo existente; vacío = borrar.
 *  Conserva las secciones estructuradas (connectors, channelLlm). */
export function saveUiConfig(root: string, vars: UiConfigVars): void {
  const data = readUiConfigFile(root);
  for (const k of UI_CONFIG_KEYS) {
    if (k in vars) {
      const v = vars[k]?.trim() ?? "";
      if (v) data[k] = v;
      else delete data[k];
    }
  }
  writeUiConfigFile(root, data);
}

/** Aplica la config guardada por el panel a process.env.
 *  - force=false (arranque del CLI): solo rellena claves que falten.
 *  - force=true  (tras guardar desde el panel): el panel manda — fija las
 *    guardadas y borra las vacías (así .env puede volver a mandar tras limpiar). */
export function applyUiConfig(root: string, force = false): void {
  const saved = loadUiConfig(root);
  for (const k of UI_CONFIG_KEYS) {
    const v = saved[k];
    if (v) {
      process.env[k] = v;
    } else if (force) {
      delete process.env[k];
    }
  }
}

/* ── Conectores de IA (globales) y asignación por canal ────── */

function asConnectors(value: unknown): Record<string, ConnectorConfig> {
  const out: Record<string, ConnectorConfig> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.name !== "string") continue;
    const source = c.source === "local" || c.source === "remote" || c.source === "cloud" ? c.source : "cloud";
    out[id] = {
      id,
      name: c.name,
      source,
      baseUrl: typeof c.baseUrl === "string" ? c.baseUrl : undefined,
      apiKey: typeof c.apiKey === "string" ? c.apiKey : undefined,
      model: typeof c.model === "string" ? c.model : undefined,
      speed: typeof c.speed === "string" ? c.speed : undefined,
      ollamaBaseUrl: typeof c.ollamaBaseUrl === "string" ? c.ollamaBaseUrl : undefined,
      ollamaModel: typeof c.ollamaModel === "string" ? c.ollamaModel : undefined,
    };
  }
  return out;
}

/** Conectores de IA definidos en el panel (globales). */
export function loadConnectors(root: string): Record<string, ConnectorConfig> {
  return asConnectors(readUiConfigFile(root).connectors);
}

export function saveConnectors(root: string, connectors: ConnectorConfig[]): void {
  const data = readUiConfigFile(root);
  const map: Record<string, unknown> = {};
  for (const c of connectors) {
    if (!c.id || !c.name) continue;
    map[c.id] = {
      name: c.name,
      source: c.source,
      baseUrl: c.baseUrl || undefined,
      apiKey: c.apiKey || undefined,
      model: c.model || undefined,
      speed: c.speed || undefined,
      ollamaBaseUrl: c.ollamaBaseUrl || undefined,
      ollamaModel: c.ollamaModel || undefined,
    };
  }
  if (Object.keys(map).length === 0) delete data.connectors;
  else data.connectors = map;
  writeUiConfigFile(root, data);
}

/* ── Notificaciones cuando el agente publica o falla ────────────────────── */

/** Destinos y eventos de notificación (se guardan en data/ui-config.json). */
export interface NotifyConfig {
  /** Webhook genérico (Slack, Make, n8n…) — activo si no está vacío. */
  webhookUrl: string;
  /** Bot token de Telegram — activo si no está vacío (con chatId). */
  telegramToken: string;
  /** Chat o grupo de Telegram donde enviar (id numérico o @usuario). */
  telegramChatId: string;
  /** Webhook URL de Discord — activo si no está vacío. */
  discordUrl: string;
  /** Avisar cuando un post se publica de verdad (no en dry-run). */
  onPublish: boolean;
  /** Avisar cuando un post falla al publicarse. */
  onFailure: boolean;
}

export function defaultNotifyConfig(): NotifyConfig {
  return { webhookUrl: "", telegramToken: "", telegramChatId: "", discordUrl: "", onPublish: true, onFailure: true };
}

/** Lee la config de notificaciones guardada por el panel ({} si no existe). */
export function loadNotifications(root: string): NotifyConfig {
  const raw = readUiConfigFile(root).notifications;
  const out = defaultNotifyConfig();
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.webhookUrl === "string") out.webhookUrl = r.webhookUrl.trim();
  if (typeof r.telegramToken === "string") out.telegramToken = r.telegramToken.trim();
  if (typeof r.telegramChatId === "string") out.telegramChatId = r.telegramChatId.trim();
  if (typeof r.discordUrl === "string") out.discordUrl = r.discordUrl.trim();
  if (typeof r.onPublish === "boolean") out.onPublish = r.onPublish;
  if (typeof r.onFailure === "boolean") out.onFailure = r.onFailure;
  return out;
}

export function saveNotifications(root: string, n: NotifyConfig): void {
  const data = readUiConfigFile(root);
  data.notifications = {
    webhookUrl: n.webhookUrl?.trim() ?? "",
    telegramToken: n.telegramToken?.trim() ?? "",
    telegramChatId: n.telegramChatId?.trim() ?? "",
    discordUrl: n.discordUrl?.trim() ?? "",
    onPublish: n.onPublish !== false,
    onFailure: n.onFailure !== false,
  };
  writeUiConfigFile(root, data);
}

/** Asignación por canal: canal → id de conector (\"\" = IA por defecto). */
export function loadChannelLlm(root: string): Partial<Record<ChannelId, string>> {
  const out: Partial<Record<ChannelId, string>> = {};
  const raw = readUiConfigFile(root).channelLlm;
  if (typeof raw !== "object" || raw === null) return out;
  for (const id of CHANNELS) {
    const v = (raw as Record<string, unknown>)[id];
    if (typeof v === "string" && v.trim()) out[id] = v;
  }
  return out;
}

export function saveChannelLlm(root: string, channelLlm: Partial<Record<ChannelId, string>>): void {
  const data = readUiConfigFile(root);
  const map: Record<string, string> = {};
  for (const id of CHANNELS) {
    const v = channelLlm[id]?.trim() ?? "";
    if (v) map[id] = v;
  }
  if (Object.keys(map).length === 0) delete data.channelLlm;
  else data.channelLlm = map;
  writeUiConfigFile(root, data);
}
