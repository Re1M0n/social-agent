import { basename } from "node:path";
import { missingCredentials, type ChannelAdapter, type PublishResult } from "./types.js";
import type { ChannelConfig, Post } from "../types.js";

/** URL base de la API de TikTok (sobrescribible con TIKTOK_API_BASE para proxies o tests). */
function apiBase(): string {
  return (process.env.TIKTOK_API_BASE ?? "https://open.tiktokapis.com/v2").replace(/\/+$/, "");
}

/** TikTok (Content Posting API). Necesita URL pública del video
 *  (configura TIKTOK_MEDIA_BASE_URL apuntando a una carpeta servida por HTTP).
 */
export const tiktokAdapter: ChannelAdapter = {
  id: "tiktok",
  name: "TikTok",

  isConfigured(config) {
    return Boolean(config.credentials.TIKTOK_ACCESS_TOKEN && config.credentials.TIKTOK_OPEN_ID);
  },

  async publish(post, config) {
    const token = config.credentials.TIKTOK_ACCESS_TOKEN;
    const openId = config.credentials.TIKTOK_OPEN_ID;
    if (!token || !openId) return missingCredentials(["TIKTOK_ACCESS_TOKEN", "TIKTOK_OPEN_ID"]);

    const filePath = post.mediaPaths?.[0];
    if (!filePath) {
      return { ok: false, error: "TikTok requiere un video para publicar." };
    }
    const mediaBaseUrl = process.env.TIKTOK_MEDIA_BASE_URL;
    if (!mediaBaseUrl) {
      return {
        ok: false,
        error: "TikTok necesita que el video sea accesible por URL pública. Define TIKTOK_MEDIA_BASE_URL en .env.",
      };
    }

    try {
      const videoUrl = `${mediaBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(basename(filePath))}`;
      const api = apiBase();

      // 1. Inicializar publicación.
      const init = await fetch(`${api}/post/publish/video/init/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({
          post_info: { title: post.text, privacy_level: "SELF_ONLY" },
          source_info: { source: "PULL_FROM_URL", video_url: videoUrl },
        }),
      });
      const initJson = (await init.json().catch(() => ({}))) as {
        data?: { publish_id?: string; upload_url?: string };
        error?: { message?: string };
      };
      const publishId = initJson.data?.publish_id;
      if (!init.ok || !publishId) {
        return { ok: false, error: `Init falló: ${initJson.error?.message ?? init.status}` };
      }

      // 2. Si la API devuelve upload_url (PUSH), subir; con PULL se procesa solo.
      const uploadUrl = initJson.data?.upload_url;
      if (uploadUrl) {
        const uploadRes = await fetch(uploadUrl, { method: "PUT" });
        if (!uploadRes.ok) return { ok: false, error: `Upload del video falló (HTTP ${uploadRes.status})` };
      }

      // 3. Consultar estado hasta completar (hasta ~2 min).
      const pollMs = Number(process.env.TIKTOK_POLL_MS ?? 5000);
      for (let i = 0; i < 24; i++) {
        const status = await fetch(
          `${api}/post/publish/status/fetch/?publish_id=${publishId}`,
          { method: "POST", headers: { Authorization: `Bearer ${token}` } },
        );
        if (!status.ok) {
          return { ok: false, error: `Consulta de estado falló (HTTP ${status.status})` };
        }
        const statusJson = (await status.json().catch(() => ({}))) as {
          data?: { status?: string; fail_reason?: string };
        };
        const s = statusJson.data?.status;
        if (s === "PUBLISH_COMPLETE") return { ok: true };
        if (s === "FAILED") {
          return { ok: false, error: `Publicación falló: ${statusJson.data?.fail_reason ?? "desconocido"}` };
        }
        await sleep(pollMs);
      }
      return { ok: false, error: "Timeout esperando estado de publicación (2 min)." };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
