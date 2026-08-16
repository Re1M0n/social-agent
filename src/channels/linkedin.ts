import { readFileSync } from "node:fs";
import { missingCredentials, type ChannelAdapter, type PublishResult } from "./types.js";
import type { ChannelConfig, Post } from "../types.js";

const API = "https://api.linkedin.com/v2";

/** LinkedIn: UGC API v2. Sube imagen como asset y crea el post. */
export const linkedinAdapter: ChannelAdapter = {
  id: "linkedin",
  name: "LinkedIn",

  isConfigured(config) {
    return Boolean(config.credentials.LINKEDIN_ACCESS_TOKEN);
  },

  async publish(post, config) {
    const token = config.credentials.LINKEDIN_ACCESS_TOKEN;
    const orgId = config.credentials.LINKEDIN_ORG_ID;
    if (!token) return missingCredentials(["LINKEDIN_ACCESS_TOKEN"]);

    const author = orgId ? `urn:li:organization:${orgId}` : undefined;
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    };

    try {
      // 1. Obtener la persona autenticada si no hay org.
      let resolvedAuthor = author;
      if (!resolvedAuthor) {
        const meRes = await fetch(`${API}/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
        const me = (await meRes.json().catch(() => ({}))) as { sub?: string };
        if (me.sub) resolvedAuthor = `urn:li:person:${me.sub}`;
        else return { ok: false, error: "No se pudo resolver el autor. Define LINKEDIN_ORG_ID o el token de un usuario." };
      }

      // 2. Si hay imagen, registrar asset y subirla.
      let imageUrn: string | undefined;
      const filePath = post.mediaPaths?.[0];
      if (filePath) {
        const register = await fetch(`${API}/assets?action=registerUpload`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            registerUploadRequest: {
              recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
              owner: resolvedAuthor,
              serviceRelationships: [
                { relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" },
              ],
            },
          }),
        });
        const regJson = (await register.json().catch(() => ({}))) as {
          value?: { uploadUrl?: string; asset?: string };
        };
        const uploadUrl = regJson.value?.uploadUrl;
        imageUrn = regJson.value?.asset;
        if (!uploadUrl || !imageUrn) {
          return { ok: false, error: "Registro de asset de imagen falló" };
        }
        const up = await fetch(uploadUrl, { method: "POST", body: readFileSync(filePath) });
        if (!up.ok) return { ok: false, error: `Subida de imagen falló (HTTP ${up.status})` };
      }

      // 3. Crear el post UGC.
      const shareMedia = imageUrn
        ? [{ status: "READY", media: imageUrn }]
        : [{ status: "READY" }];
      const payload = {
        author: resolvedAuthor,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: post.text },
            shareMediaCategory: imageUrn ? "IMAGE" : "NONE",
            media: shareMedia,
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      };
      const res = await fetch(`${API}/ugcPosts`, { method: "POST", headers, body: JSON.stringify(payload) });
      const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (res.ok && json.id) return { ok: true, url: `https://www.linkedin.com/feed/update/${json.id}` };
      return { ok: false, error: json.message ?? `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
