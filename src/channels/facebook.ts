import { missingCredentials, type ChannelAdapter, type PublishResult } from "./types.js";
import { uploadMultipart } from "./http.js";
import type { ChannelConfig, Post } from "../types.js";

const GRAPH = "https://graph.facebook.com/v21.0";

/** Facebook (Graph API): texto en /feed, imagen o video con subida binaria directa. */
export const facebookAdapter: ChannelAdapter = {
  id: "facebook",
  name: "Facebook",

  isConfigured(config) {
    return Boolean(config.credentials.FACEBOOK_ACCESS_TOKEN && config.credentials.FACEBOOK_PAGE_ID);
  },

  async publish(post, config) {
    const token = config.credentials.FACEBOOK_ACCESS_TOKEN;
    const pageId = config.credentials.FACEBOOK_PAGE_ID;
    if (!token || !pageId) return missingCredentials(["FACEBOOK_ACCESS_TOKEN", "FACEBOOK_PAGE_ID"]);

    try {
      const filePath = post.mediaPaths?.[0];
      const isVideo = filePath?.toLowerCase().match(/\.(mp4|mov|webm|mkv|avi|m4v)$/);

      if (filePath) {
        // Subida binaria directa (imagen o video).
        const endpoint = isVideo ? "videos" : "photos";
        const res = await uploadMultipart(
          `${GRAPH}/${pageId}/${endpoint}?access_token=${token}`,
          filePath,
          undefined,
          "source",
          { caption: post.text },
        );
        const json = (await res.json().catch(() => ({}))) as {
          id?: string;
          post_id?: string;
          error?: { message?: string };
        };
        if (res.ok) {
          const postId = json.post_id ?? json.id;
          return { ok: true, url: postId ? `https://www.facebook.com/${postId}` : undefined };
        }
        return { ok: false, error: json.error?.message ?? `HTTP ${res.status}` };
      }

      // Solo texto.
      const res = await fetch(
        `${GRAPH}/${pageId}/feed?access_token=${token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: post.text }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: { message?: string };
      };
      if (res.ok && json.id) {
        return { ok: true, url: `https://www.facebook.com/${json.id}` };
      }
      return { ok: false, error: json.error?.message ?? `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
