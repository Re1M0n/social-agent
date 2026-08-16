import { getAdapter } from "./channels/index.js";
import type { AgentConfig } from "./config.js";
import { nextSlot } from "./scheduler.js";
import type { Store } from "./storage.js";
import type { ChannelId, Post } from "./types.js";

/** Límites de caracteres por plataforma (también usados por el panel). */
export const CHANNEL_LIMITS: Record<ChannelId, number> = {
  mastodon: 500,
  bluesky: 300,
  twitter: 280,
  linkedin: 3000,
  instagram: 2200,
  facebook: 63206,
  tiktok: 2200,
};

export interface PublishOutcome {
  published: number;
  failed: number;
  skipped: number;
  dryRun: boolean;
}

export type PublishResult = "published" | "failed" | "skipped";

/** Publica un único post (dry-run respetado). No lanza: siempre devuelve resultado. */
export async function publishOnePost(
  config: AgentConfig,
  store: Store,
  post: Post,
): Promise<PublishResult> {
  const channelConfig = config.channels[post.channel];

  if (!channelConfig.enabled) {
    store.updatePost(post.id, { status: "failed", error: "Canal deshabilitado en .env" });
    return "skipped";
  }

  const limit = CHANNEL_LIMITS[post.channel];
  if (limit && post.text.length > limit) {
    store.updatePost(post.id, {
      status: "failed",
      error: `Texto de ${post.text.length} caracteres excede el límite de ${limit} del canal.`,
    });
    return "failed";
  }

  if (config.dryRun) {
    store.updatePost(post.id, {
      status: "published",
      publishedAt: new Date().toISOString(),
      postUrl: `dry-run://${post.channel}/${post.id}`,
      error: undefined,
    });
    return "published";
  }

  const adapter = getAdapter(post.channel);
  if (!adapter.isConfigured(channelConfig)) {
    store.updatePost(post.id, {
      status: "failed",
      error: "Canal sin credenciales: configura el .env o deshabilita el canal.",
    });
    return "skipped";
  }

  store.updatePost(post.id, { attempts: post.attempts + 1 });
  const result = await adapter.publish(post, channelConfig);
  if (result.ok) {
    store.updatePost(post.id, {
      status: "published",
      publishedAt: new Date().toISOString(),
      postUrl: result.url,
      error: undefined,
    });
    return "published";
  }
  store.updatePost(post.id, { status: "failed", error: result.error });
  return "failed";
}

/** Publica los posts cuyo horario ya llegó (o todos los drafts si force=true). */
export async function publishDue(
  config: AgentConfig,
  store: Store,
  force = false,
): Promise<PublishOutcome> {
  const outcome: PublishOutcome = { published: 0, failed: 0, skipped: 0, dryRun: config.dryRun };
  const now = Date.now();

  const due = store.posts.filter((p) => {
    if (force) return p.status === "draft" || p.status === "scheduled" || p.status === "failed";
    if (p.status === "scheduled") return (p.scheduledFor ? Date.parse(p.scheduledFor) : 0) <= now;
    return false;
  });

  for (const post of due) {
    const result = await publishOnePost(config, store, post);
    if (result === "published") outcome.published++;
    else if (result === "failed") outcome.failed++;
    else outcome.skipped++;
  }

  return outcome;
}

/** Publica un post concreto por su id (para el panel: "Publicar ahora"). */
export async function publishSingle(config: AgentConfig, store: Store, postId: string): Promise<PublishResult | undefined> {
  const post = store.posts.find((p) => p.id === postId);
  if (!post) return undefined;
  return publishOnePost(config, store, post);
}

/** Programa un post concreto en su siguiente hueco óptimo (aprobación desde el panel). */
export function scheduleSingle(config: AgentConfig, store: Store, postId: string): Post | undefined {
  const post = store.posts.find((p) => p.id === postId);
  if (!post) return undefined;
  const slot = nextSlot(post.channel, new Date(), config.minIntervalMs);
  const updated = store.updatePost(post.id, { status: "scheduled", scheduledFor: slot.toISOString(), error: undefined });
  return updated ?? post;
}

/** Programa drafts pendientes en horarios óptimos por canal. */
export function scheduleDrafts(config: AgentConfig, store: Store): number {
  let scheduled = 0;
  const drafts = store.getPostsByStatus("draft");
  const afterByChannel = new Map<string, Date>();

  for (const post of drafts) {
    const after = afterByChannel.get(post.channel) ?? new Date();
    const slot = nextSlot(post.channel, after, config.minIntervalMs);
    afterByChannel.set(post.channel, new Date(slot.getTime() + config.minIntervalMs));
    store.updatePost(post.id, { status: "scheduled", scheduledFor: slot.toISOString() });
    scheduled++;
  }
  return scheduled;
}

/** En modo autónomo: programa y publica inmediatamente lo que toque.
 *  Con autoPublish=false deja drafts para revisión humana. */
export async function autoRun(config: AgentConfig, store: Store): Promise<{
  generated: number;
  scheduled: number;
  publish: PublishOutcome;
}> {
  let generated = 0;
  if (config.autoPublish) {
    generated = scheduleDrafts(config, store);
  }
  const publish = await publishDue(config, store);
  return { generated, scheduled: generated, publish };
}
