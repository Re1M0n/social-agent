import type { ChannelConfig, Post } from "../types.js";
import { uploadMultipart } from "./http.js";
import { missingCredentials, type ChannelAdapter, type PublishResult } from "./types.js";

/** Mastodon: API v1 de la instancia. Sube media y publica status. */
export const mastodonAdapter: ChannelAdapter = {
  id: "mastodon",
  name: "Mastodon",

  isConfigured(config) {
    return Boolean(config.credentials.MASTODON_URL && config.credentials.MASTODON_TOKEN);
  },

  async publish(post, config) {
    const instance = config.credentials.MASTODON_URL?.replace(/\/+$/, "");
    const token = config.credentials.MASTODON_TOKEN;
    if (!instance || !token) return missingCredentials(["MASTODON_URL", "MASTODON_TOKEN"]);

    try {
      // 1. Subir media (hasta 4 archivos).
      const mediaIds: string[] = [];
      for (const filePath of post.mediaPaths ?? []) {
        const res = await uploadMultipart(`${instance}/api/v1/media`, filePath, token, "file", {
          description: post.text.slice(0, 1500),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return { ok: false, error: `Subida de media falló (HTTP ${res.status}): ${body.slice(0, 200)}` };
        }
        const json = (await res.json()) as { id?: string };
        if (json.id) mediaIds.push(json.id);
      }

      // 2. Publicar status.
      const body = JSON.stringify({
        status: post.text,
        media_ids: mediaIds,
        visibility: (config.options.visibility as string) ?? "public",
        language: "es",
      });
      const res = await fetch(`${instance}/api/v1/statuses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": post.id,
        },
        body,
      });
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.ok) return { ok: true, url: json.url };
      return { ok: false, error: json.error ?? `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
