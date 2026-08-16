/** Tipos compartidos del sistema. */

/** Canales soportados. */
export type ChannelId =
  | "mastodon"
  | "bluesky"
  | "twitter"
  | "linkedin"
  | "instagram"
  | "facebook"
  | "tiktok";

export const CHANNELS: ChannelId[] = [
  "mastodon",
  "bluesky",
  "twitter",
  "linkedin",
  "instagram",
  "facebook",
  "tiktok",
];

/** Fuente de contenido: una idea base o un archivo de media. */
export interface ContentItem {
  id: string;
  kind: "idea" | "media";
  /** Texto de la idea (markdown) o nombre del archivo. */
  title: string;
  /** Cuerpo completo de la idea / metadatos del archivo. */
  body?: string;
  /** Ruta del archivo de media (si aplica). */
  filePath?: string;
  /** Tipo MIME aproximado (video/photo/audio). */
  mediaType?: "video" | "photo" | "audio" | "text";
  /** Etiquetas extra que el usuario quiera forzar. */
  tags?: string[];
  ingestedAt: string;
}

/** Publicación generada para una plataforma concreta. */
export interface Draft {
  id: string;
  contentItemId: string;
  channel: ChannelId;
  /** Texto final listo para publicar. */
  text: string;
  /** Ruta(s) de media adjunta (si aplica). */
  mediaPaths?: string[];
  /** Hashtags/categorías sugeridos. */
  tags?: string[];
  /** Explicación de la estrategia (para revisión humana). */
  rationale?: string;
  /** Variantes A/B (titulares/ganchos alternativos listos para publicar). */
  variants?: string[];
  createdAt: string;
}

export type PostStatus = "draft" | "scheduled" | "published" | "failed";

export interface Post extends Draft {
  status: PostStatus;
  /** Timestamp ISO en el que se programó publicar. */
  scheduledFor?: string;
  /** Timestamp ISO en el que se publicó. */
  publishedAt?: string;
  /** URL del post publicado. */
  postUrl?: string;
  /** Error si la publicación falló. */
  error?: string;
  attempts: number;
}

/** Configuración de un canal concreto. */
export interface ChannelConfig {
  enabled: boolean;
  /** Datos de credenciales por canal (se leen del entorno). */
  credentials: Record<string, string | undefined>;
  /** Opciones específicas del canal. */
  options: Record<string, unknown>;
}
