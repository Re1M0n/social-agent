import { readFileSync } from "node:fs";
import { mimeOf } from "./http.js";
import { missingCredentials, type ChannelAdapter, type PublishResult } from "./types.js";
import type { ChannelConfig, Post } from "../types.js";

const SERVICE = "https://bsky.social/xrpc";

interface Session {
  accessJwt: string;
  did: string;
}

async function createSession(handle: string, appPassword: string): Promise<Session> {
  const res = await fetch(`${SERVICE}/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Login Bluesky falló (${res.status}): ${body.slice(0, 200)}`);
  }
  return (await res.json()) as Session;
}

async function uploadBlob(session: Session, filePath: string): Promise<{ blob: unknown }> {
  const data = readFileSync(filePath);
  const res = await fetch(`${SERVICE}/com.atproto.repo.uploadBlob`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
      "Content-Type": mimeOf(filePath),
    },
    body: data,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Upload blob falló (${res.status}): ${body.slice(0, 200)}`);
  }
  return (await res.json()) as { blob: unknown };
}

/** Bluesky: AT Protocol. Crea sesión, sube blobs y crea el registro del post. */
export const blueskyAdapter: ChannelAdapter = {
  id: "bluesky",
  name: "Bluesky",

  isConfigured(config) {
    return Boolean(config.credentials.BLUESKY_HANDLE && config.credentials.BLUESKY_APP_PASSWORD);
  },

  async publish(post, config) {
    const handle = config.credentials.BLUESKY_HANDLE;
    const appPassword = config.credentials.BLUESKY_APP_PASSWORD;
    if (!handle || !appPassword) {
      return missingCredentials(["BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD"]);
    }

    try {
      const session = await createSession(handle, appPassword);

      // Imágenes: hasta 4 en el post.
      const images: unknown[] = [];
      for (const filePath of (post.mediaPaths ?? []).slice(0, 4)) {
        const { blob } = await uploadBlob(session, filePath);
        images.push({ image: blob, alt: post.text.slice(0, 200) });
      }

      const record: Record<string, unknown> = {
        text: post.text,
        createdAt: new Date().toISOString(),
        langs: ["es"],
        $type: "app.bsky.feed.post",
      };
      if (images.length > 0) {
        record.embed = { $type: "app.bsky.embed.images", images };
      }

      const res = await fetch(`${SERVICE}/com.atproto.repo.createRecord`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repo: session.did,
          collection: "app.bsky.feed.post",
          record,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { uri?: string; error?: string };
      if (res.ok && json.uri) {
        const [repo, collection, rkey] = json.uri.split("/").slice(2);
        return {
          ok: true,
          url: `https://bsky.app/profile/${repo}/post/${rkey}`,
        };
      }
      return { ok: false, error: json.error ?? `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
