import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChannelConfig, ChannelId, Post } from "./types.js";

/** Engagement de una publicación concreta. */
export interface Engagement {
  likes?: number;
  reposts?: number;
  comments?: number;
  clicks?: number;
  impressions?: number;
}

export interface PostMetrics {
  channel: ChannelId;
  url?: string;
  engagement: Engagement;
  fetchedAt: string;
}

/** Estado de métricas persistente (data/metrics.json). */
export interface MetricsData {
  followers: Partial<Record<ChannelId, { count: number; fetchedAt: string }>>;
  posts: Record<string, PostMetrics>;
  updatedAt?: string;
}

export class MetricsStore {
  data: MetricsData;

  constructor(private file: string) {
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, "utf8")) as MetricsData;
      } catch {
        this.data = { followers: {}, posts: {} };
      }
    } else {
      this.data = { followers: {}, posts: {} };
    }
    if (!this.data.followers) this.data.followers = {};
    if (!this.data.posts) this.data.posts = {};
  }

  save(): void {
    this.data.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  setFollowers(channel: ChannelId, count: number): void {
    this.data.followers[channel] = { count, fetchedAt: new Date().toISOString() };
    this.save();
  }

  setPostMetrics(postId: string, metrics: PostMetrics): void {
    this.data.posts[postId] = metrics;
    this.save();
  }
}

/* ── Fetchers reales por canal ─────────────────────────────── */

/** Seguidores actuales del canal. Devuelve undefined si no se puede consultar. */
export async function fetchFollowers(
  channel: ChannelId,
  config: ChannelConfig,
): Promise<number | undefined> {
  try {
    switch (channel) {
      case "mastodon": {
        const instance = config.credentials.MASTODON_URL?.replace(/\/+$/, "");
        const token = config.credentials.MASTODON_TOKEN;
        if (!instance || !token) return undefined;
        const res = await fetch(`${instance}/api/v1/accounts/verify_credentials`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = (await res.json().catch(() => ({}))) as { followers_count?: number };
        return res.ok ? json.followers_count : undefined;
      }
      case "bluesky": {
        const handle = config.credentials.BLUESKY_HANDLE;
        const appPassword = config.credentials.BLUESKY_APP_PASSWORD;
        if (!handle || !appPassword) return undefined;
        const xrpc = (process.env.BLUESKY_XRPC ?? "https://bsky.social/xrpc").replace(/\/+$/, "");
        const session = await createBskySession(xrpc, handle, appPassword);
        const res = await fetch(`${xrpc}/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`, {
          headers: { Authorization: `Bearer ${session.accessJwt}` },
        });
        const json = (await res.json().catch(() => ({}))) as { followersCount?: number };
        return res.ok ? json.followersCount : undefined;
      }
      default:
        // X, LinkedIn, Instagram, Facebook, TikTok: requieren sus APIs propias.
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Engagement de un post publicado. postUrl se usa para reconstruir el id. */
export async function fetchPostEngagement(
  post: Post,
  config: ChannelConfig,
): Promise<Engagement | undefined> {
  try {
    switch (post.channel) {
      case "mastodon": {
        const instance = config.credentials.MASTODON_URL?.replace(/\/+$/, "");
        const token = config.credentials.MASTODON_TOKEN;
        const id = post.postUrl?.match(/\/(\d+)\/?$/)?.[1];
        if (!instance || !token || !id) return undefined;
        const res = await fetch(`${instance}/api/v1/statuses/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = (await res.json().catch(() => ({}))) as {
          favourites_count?: number;
          reblogs_count?: number;
          replies_count?: number;
        };
        if (!res.ok) return undefined;
        return {
          likes: json.favourites_count,
          reposts: json.reblogs_count,
          comments: json.replies_count,
        };
      }
      case "bluesky": {
        const handle = config.credentials.BLUESKY_HANDLE;
        const appPassword = config.credentials.BLUESKY_APP_PASSWORD;
        const uri = bskyUriFromUrl(post.postUrl);
        if (!handle || !appPassword || !uri) return undefined;
        const xrpc = (process.env.BLUESKY_XRPC ?? "https://bsky.social/xrpc").replace(/\/+$/, "");
        const session = await createBskySession(xrpc, handle, appPassword);
        const res = await fetch(`${xrpc}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}`, {
          headers: { Authorization: `Bearer ${session.accessJwt}` },
        });
        const json = (await res.json().catch(() => ({}))) as {
          thread?: { post?: { likeCount?: number; repostCount?: number; replyCount?: number } };
        };
        const p = json.thread?.post;
        if (!res.ok || !p) return undefined;
        return { likes: p.likeCount, reposts: p.repostCount, comments: p.replyCount };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Convierte la URL amigable de un post de Bluesky en AT-URI. */
export function bskyUriFromUrl(url?: string): string | undefined {
  const match = url?.match(/bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/);
  if (!match) return undefined;
  return `at://${match[1]}/app.bsky.feed.post/${match[2]}`;
}

async function createBskySession(
  xrpc: string,
  handle: string,
  appPassword: string,
): Promise<{ accessJwt: string }> {
  const res = await fetch(`${xrpc}/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  });
  if (!res.ok) throw new Error(`login bluesky ${res.status}`);
  return (await res.json()) as { accessJwt: string };
}

/* ── Datos manuales (canales sin API accesible) ────────────── */

export interface ManualMetrics {
  followers?: Partial<Record<ChannelId, number>>;
  posts?: Record<string, Partial<Engagement>>;
}

/** Carga data/metrics-manual.json si existe (para X, LinkedIn, IG, FB, TikTok…). */
export function loadManualMetrics(file: string): ManualMetrics {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ManualMetrics;
  } catch {
    return {};
  }
}
