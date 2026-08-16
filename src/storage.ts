import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ContentItem, Draft, Post, PostStatus } from "./types.js";

export interface StoreData {
  contentItems: ContentItem[];
  posts: Post[];
}

/** Almacenamiento persistente en un único JSON (simple y portable). */
export class Store {
  private data: StoreData;

  constructor(private file: string) {
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, "utf8")) as StoreData;
      } catch {
        this.data = { contentItems: [], posts: [] };
      }
    } else {
      this.data = { contentItems: [], posts: [] };
    }
    if (!this.data.contentItems) this.data.contentItems = [];
    if (!this.data.posts) this.data.posts = [];
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  get contentItems(): ContentItem[] {
    return this.data.contentItems;
  }

  get posts(): Post[] {
    return this.data.posts;
  }

  getContentItem(id: string): ContentItem | undefined {
    return this.data.contentItems.find((c) => c.id === id);
  }

  /** Registra un ítem de contenido si no existe ya (dedupe por id). */
  addContentItem(item: ContentItem): boolean {
    if (this.data.contentItems.some((c) => c.id === item.id)) return false;
    this.data.contentItems.push(item);
    this.save();
    return true;
  }

  /** Añade drafts (si el mismo id ya existe, no duplica). */
  addDrafts(drafts: Draft[]): number {
    let added = 0;
    const existing = new Set(this.data.posts.map((p) => p.id));
    for (const d of drafts) {
      if (existing.has(d.id)) continue;
      this.data.posts.push({ ...d, status: "draft", attempts: 0 });
      existing.add(d.id);
      added++;
    }
    if (added > 0) this.save();
    return added;
  }

  getPostsByStatus(...statuses: PostStatus[]): Post[] {
    return this.data.posts.filter((p) => statuses.includes(p.status));
  }

  getPostsForItem(contentItemId: string): Post[] {
    return this.data.posts.filter((p) => p.contentItemId === contentItemId);
  }

  updatePost(id: string, patch: Partial<Post>): Post | undefined {
    const post = this.data.posts.find((p) => p.id === id);
    if (!post) return undefined;
    Object.assign(post, patch);
    this.save();
    return post;
  }

  /** Elimina un post (para descartar drafts). Devuelve true si existía. */
  removePost(id: string): boolean {
    const before = this.data.posts.length;
    this.data.posts = this.data.posts.filter((p) => p.id !== id);
    if (this.data.posts.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  /** Dado un id de contenido, devuelve las plataformas ya cubiertas. */
  channelsCovered(contentItemId: string): Set<string> {
    return new Set(this.data.posts.filter((p) => p.contentItemId === contentItemId).map((p) => p.channel));
  }

  stats(): { items: number; drafts: number; scheduled: number; published: number; failed: number } {
    return {
      items: this.data.contentItems.length,
      drafts: this.getPostsByStatus("draft").length,
      scheduled: this.getPostsByStatus("scheduled").length,
      published: this.getPostsByStatus("published").length,
      failed: this.getPostsByStatus("failed").length,
    };
  }
}
