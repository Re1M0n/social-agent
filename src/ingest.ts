import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { CONTENT_EXTENSIONS, type AgentConfig, mediaTypeOf } from "./config.js";
import type { Store } from "./storage.js";
import type { ContentItem } from "./types.js";

function hashId(...parts: string[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** Extrae la primera línea como título y el resto como cuerpo. */
function parseIdeaFile(text: string): { title: string; body: string } {
  const lines = text.split(/\r?\n/);
  let title = "";
  const bodyLines: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!title && t && !t.startsWith("#")) {
      title = t;
    } else if (title) {
      bodyLines.push(line);
    } else if (t.startsWith("#")) {
      // Encabezado markdown como título.
      title = t.replace(/^#+\s*/, "").trim();
    }
  }
  if (!title) title = basename(process.cwd()) + " (idea)";
  return { title, body: bodyLines.join("\n").trim() };
}

/** Escanea las carpetas de ideas y media y registra ítems nuevos en el store. */
export function ingest(config: AgentConfig, store: Store): ContentItem[] {
  const added: ContentItem[] = [];
  const now = new Date().toISOString();

  // --- Ideas (archivos .md / .txt) ---
  const ideasDir = config.ideasDir;
  if (existsSync(ideasDir)) {
    for (const file of readdirSync(ideasDir)) {
      const ext = extname(file).toLowerCase();
      if (![".md", ".txt", ".markdown"].includes(ext)) continue;
      const full = join(ideasDir, file);
      const content = readFileSync(full, "utf8");
      const { title, body } = parseIdeaFile(content);
      const id = hashId("idea", file);
      const item: ContentItem = {
        id,
        kind: "idea",
        title,
        body,
        mediaType: "text",
        sourceFile: full,
        ingestedAt: now,
      };
      if (store.addContentItem(item)) added.push(item);
    }
  }

  // --- Media (fotos / videos / audio) ---
  const mediaDir = config.mediaDir;
  if (existsSync(mediaDir)) {
    for (const file of readdirSync(mediaDir)) {
      const ext = extname(file).toLowerCase();
      if (!CONTENT_EXTENSIONS.includes(ext)) continue;
      const full = join(mediaDir, file);
      const stat = statSync(full);
      const rel = relative(config.contentDir, full);
      const id = hashId("media", file);
      const item: ContentItem = {
        id,
        kind: "media",
        title: basename(file, extname(file)).replace(/[_-]+/g, " "),
        body: `Archivo: ${rel}\nTamaño: ${(stat.size / 1024 / 1024).toFixed(1)} MB`,
        filePath: full,
        sourceFile: full,
        mediaType: mediaTypeOf(file),
        ingestedAt: now,
      };
      if (store.addContentItem(item)) added.push(item);
    }
  }

  return added;
}
