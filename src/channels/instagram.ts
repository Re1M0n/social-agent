import { basename } from "node:path";
import { missingCredentials, type ChannelAdapter, type PublishResult } from "./types.js";
import type { ChannelConfig, Post } from "../types.js";

/** URL base de la Graph API (sobrescribible con INSTAGRAM_GRAPH_BASE para proxies o tests). */
function graphBase(): string {
  return (process.env.INSTAGRAM_GRAPH_BASE ?? "https://graph.facebook.com/v21.0").replace(/\/+$/, "");
}

/** Instagram (Graph API). Necesita que la media sea accesible por URL pública
 *  (configura INSTAGRAM_MEDIA_BASE_URL apuntando a una carpeta servida por HTTP).
 */
export const instagramAdapter: ChannelAdapter = {
  id: "instagram",
  name: "Instagram",

  isConfigured(config) {
    return Boolean(config.credentials.INSTAGRAM_ACCESS_TOKEN && config.credentials.INSTAGRAM_USER_ID);
  },

  async publish(post, config) {
    const token = config.credentials.INSTAGRAM_ACCESS_TOKEN;
    const userId = config.credentials.INSTAGRAM_USER_ID;
    if (!token || !userId) return missingCredentials(["INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_USER_ID"]);

    const mediaBaseUrl = (config.options.mediaBaseUrl as string) ??
      process.env.INSTAGRAM_MEDIA_BASE_URL;
    const filePath = post.mediaPaths?.[0];
    if (!filePath) {
      return { ok: false, error: "Instagram requiere media (imagen o video) para publicar." };
    }
    if (!mediaBaseUrl) {
      return {
        ok: false,
        error:
          "Instagram necesita que la media sea accesible por URL pública. Define INSTAGRAM_MEDIA_BASE_URL en .env (carpeta servida por HTTP).",
      };
    }

    try {
      const mediaUrl = `${mediaBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(basename(filePath))}`;
      const isVideo = post.mediaPaths?.[0]?.toLowerCase().match(/\.(mp4|mov|webm|mkv|avi|m4v)$/);

      const graph = graphBase();
      const containerRes = await fetch(
        `${graph}/${userId}/media?access_token=${token}&image_url=${encodeURIComponent(mediaUrl)}&video_url=${encodeURIComponent(mediaUrl)}&media_type=${isVideo ? "VIDEO" : "IMAGE"}&caption=${encodeURIComponent(post.text)}`,
        { method: "POST" },
      );
      const container = (await containerRes.json().catch(() => ({}))) as {
        id?: string;
        error?: { message?: string };
      };
      if (!containerRes.ok || !container.id) {
        return { ok: false, error: `Crear container falló: ${container.error?.message ?? containerRes.status}` };
      }

      // Esperar a que el container esté listo (hasta ~60s).
      const pollMs = Number(process.env.INSTAGRAM_POLL_MS ?? 5000);
      let ready = false;
      for (let i = 0; i < 12; i++) {
        const statusRes = await fetch(
          `${graph}/${container.id}?fields=status_code&access_token=${token}`,
        );
        const status = (await statusRes.json().catch(() => ({}))) as { status_code?: string };
        if (status.status_code === "FINISHED") {
          ready = true;
          break;
        }
        if (status.status_code === "ERROR") {
          return { ok: false, error: "El container de media terminó en ERROR (revisa formato/URL)." };
        }
        await sleep(pollMs);
      }
      if (!ready) return { ok: false, error: "Timeout esperando el container de media (60s)." };

      const pubRes = await fetch(`${graph}/${userId}/media_publish?access_token=${token}&creation_id=${container.id}`, {
        method: "POST",
      });
      const pub = (await pubRes.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
      if (pubRes.ok && pub.id) {
        return { ok: true, url: `https://www.instagram.com/p/${pub.id}/` };
      }
      return { ok: false, error: pub.error?.message ?? `HTTP ${pubRes.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
