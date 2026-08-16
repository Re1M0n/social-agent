import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mimeOf } from "./http.js";
import { missingCredentials, type ChannelAdapter, type PublishResult } from "./types.js";
import type { ChannelConfig, Post } from "../types.js";

/* --- OAuth 1.0a (HMAC-SHA1) para la API v2 de X --- */

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function oauthSignature(
  method: string,
  baseUrl: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  const base = `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(sorted)}`;
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac("sha1", key).update(base).digest("base64");
}

function authHeader(
  method: string,
  url: string,
  bodyParams: Record<string, string>,
  creds: { consumerKey: string; consumerSecret: string; token: string; tokenSecret: string },
): string {
  const oauth = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  const all = { ...oauth, ...bodyParams };
  const signature = oauthSignature(method, url, all, creds.consumerSecret, creds.tokenSecret);
  const header = { ...oauth, oauth_signature: signature };
  return "OAuth " + Object.entries(header)
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ");
}

/** X (Twitter) API v2: sube media y publica tweet con OAuth 1.0a. */
export const twitterAdapter: ChannelAdapter = {
  id: "twitter",
  name: "X (Twitter)",

  isConfigured(config) {
    return Boolean(
      config.credentials.TWITTER_API_KEY &&
        config.credentials.TWITTER_API_SECRET &&
        config.credentials.TWITTER_ACCESS_TOKEN &&
        config.credentials.TWITTER_ACCESS_SECRET,
    );
  },

  async publish(post, config) {
    const { TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET } =
      config.credentials;
    if (!TWITTER_API_KEY || !TWITTER_API_SECRET || !TWITTER_ACCESS_TOKEN || !TWITTER_ACCESS_SECRET) {
      return missingCredentials(["TWITTER_API_KEY", "TWITTER_API_SECRET", "TWITTER_ACCESS_TOKEN", "TWITTER_ACCESS_SECRET"]);
    }
    const creds = {
      consumerKey: TWITTER_API_KEY,
      consumerSecret: TWITTER_API_SECRET,
      token: TWITTER_ACCESS_TOKEN,
      tokenSecret: TWITTER_ACCESS_SECRET,
    };

    try {
      // 1. Subir media (v2: /2/media/upload, un chunk por simplicidad).
      const mediaIds: string[] = [];
      for (const filePath of post.mediaPaths ?? []) {
        const data = readFileSync(filePath);
        const uploadUrl = "https://upload.twitter.com/2/media/upload";
        const bodyParams = {
          media_data: data.toString("base64"),
          media_category: mimeOf(filePath).startsWith("video") ? "tweet_video" : "tweet_image",
        };
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            Authorization: authHeader("POST", uploadUrl, bodyParams, creds),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(bodyParams).toString(),
        });
        const json = (await res.json().catch(() => ({}))) as { media_id_string?: string; errors?: { message?: string }[] };
        if (!res.ok || !json.media_id_string) {
          return { ok: false, error: `Upload media falló: ${json.errors?.[0]?.message ?? res.status}` };
        }
        mediaIds.push(json.media_id_string);
      }

      // 2. Crear tweet.
      const postUrl = "https://api.twitter.com/2/tweets";
      const payload: Record<string, unknown> = { text: post.text };
      if (mediaIds.length > 0) payload.media = { media_ids: mediaIds };
      const body = JSON.stringify(payload);
      const bodyParams: Record<string, string> = {};
      const res = await fetch(postUrl, {
        method: "POST",
        headers: {
          Authorization: authHeader("POST", postUrl, bodyParams, creds),
          "Content-Type": "application/json",
        },
        body,
      });
      const json = (await res.json().catch(() => ({}))) as { data?: { id?: string; text?: string }; errors?: { message?: string }[] };
      if (res.ok && json.data?.id) {
        return { ok: true, url: `https://x.com/i/status/${json.data.id}` };
      }
      return { ok: false, error: json.errors?.[0]?.message ?? `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
