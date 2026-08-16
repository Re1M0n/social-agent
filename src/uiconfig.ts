import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Variables de IA y canales editables desde el panel web (se guardan en
 *  data/ui-config.json y se aplican a process.env antes de cargar la config). */
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
  "CHANNEL_MASTODON_ENABLED",
  "CHANNEL_BLUESKY_ENABLED",
  "CHANNEL_TWITTER_ENABLED",
  "CHANNEL_LINKEDIN_ENABLED",
  "CHANNEL_INSTAGRAM_ENABLED",
  "CHANNEL_FACEBOOK_ENABLED",
  "CHANNEL_TIKTOK_ENABLED",
] as const;

export type UiConfigKey = (typeof UI_CONFIG_KEYS)[number];
export type UiConfigVars = Partial<Record<UiConfigKey, string>>;

/** Ruta del archivo de config del panel (junto a data/agent.json). */
export function uiConfigFile(root: string): string {
  return join(root, "data", "ui-config.json");
}

/** Lee las variables guardadas por el panel ({} si no existe o está corrupto). */
export function loadUiConfig(root: string): UiConfigVars {
  const file = uiConfigFile(root);
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const out: UiConfigVars = {};
    for (const k of UI_CONFIG_KEYS) {
      const v = data[k];
      if (typeof v === "string" && v.trim()) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Guarda las variables del panel: mezcla con lo existente; valor vacío = borrar. */
export function saveUiConfig(root: string, vars: UiConfigVars): void {
  const file = uiConfigFile(root);
  mkdirSync(dirname(file), { recursive: true });
  const existing = loadUiConfig(root);
  for (const k of UI_CONFIG_KEYS) {
    if (k in vars) {
      const v = vars[k]?.trim() ?? "";
      if (v) existing[k] = v;
      else delete existing[k];
    }
  }
  writeFileSync(file, JSON.stringify(existing, null, 2) + "\n");
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
