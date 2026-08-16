#!/usr/bin/env node
/**
 * Descarga el binario de yt-dlp (gratis, sin registro) a tools/.
 * Úsalo si quieres importar vídeos de YouTube/TikTok desde el panel:
 *   npm run setup:tools
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolsDir = join(root, "tools");
const isWin = process.platform === "win32";
const exe = isWin ? "yt-dlp.exe" : "yt-dlp";
const url =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/" +
  (isWin ? "yt-dlp.exe" : "yt-dlp_linux");

mkdirSync(toolsDir, { recursive: true });
console.log(`Descargando ${exe} desde GitHub…`);
const res = await fetch(url);
if (!res.ok) throw new Error(`HTTP ${res.status} al descargar yt-dlp`);
const bytes = Buffer.from(await res.arrayBuffer());
const dest = join(toolsDir, exe);
writeFileSync(dest, bytes);
if (!isWin) chmodSync(dest, 0o755);
console.log(`✓ ${exe} listo (${(bytes.length / 1024 / 1024).toFixed(1)} MB) en ${dest}`);
console.log("Ya puedes pegar URLs de YouTube/TikTok en el panel (pestaña ⚡ Generar).");
