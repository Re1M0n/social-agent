import type { ChannelConfig, ChannelId, Post } from "../types.js";

export interface PublishResult {
  ok: boolean;
  url?: string;
  error?: string;
}

export interface ChannelAdapter {
  id: ChannelId;
  name: string;
  /** ¿Están presentes las credenciales necesarias? */
  isConfigured(config: ChannelConfig): boolean;
  /** Publica el post. Nunca lanza: devuelve PublishResult. */
  publish(post: Post, config: ChannelConfig): Promise<PublishResult>;
}

/** Utilidad: devuelve un error claro si faltan credenciales. */
export function missingCredentials(keys: string[]): PublishResult {
  return {
    ok: false,
    error: `Faltan credenciales: ${keys.join(", ")}. Revísalas en .env`,
  };
}
