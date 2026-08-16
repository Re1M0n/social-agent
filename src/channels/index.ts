import type { ChannelId } from "../types.js";
import { blueskyAdapter } from "./bluesky.js";
import { facebookAdapter } from "./facebook.js";
import { instagramAdapter } from "./instagram.js";
import { linkedinAdapter } from "./linkedin.js";
import { mastodonAdapter } from "./mastodon.js";
import { tiktokAdapter } from "./tiktok.js";
import { twitterAdapter } from "./twitter.js";
import type { ChannelAdapter } from "./types.js";

export const ADAPTERS: Record<ChannelId, ChannelAdapter> = {
  mastodon: mastodonAdapter,
  bluesky: blueskyAdapter,
  twitter: twitterAdapter,
  linkedin: linkedinAdapter,
  instagram: instagramAdapter,
  facebook: facebookAdapter,
  tiktok: tiktokAdapter,
};

export function getAdapter(channel: ChannelId): ChannelAdapter {
  return ADAPTERS[channel];
}

/** Canales habilitados (por credenciales o flag CHANNEL_X_ENABLED). */
export function enabledChannels(config: Record<ChannelId, { enabled: boolean }>): ChannelId[] {
  return (Object.keys(config) as ChannelId[]).filter((id) => config[id].enabled);
}

export type { ChannelAdapter, PublishResult } from "./types.js";
