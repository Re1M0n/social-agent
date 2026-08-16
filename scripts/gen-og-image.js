// Genera la imagen Open Graph (assets/og-image.png) a partir de assets/og-image.svg.
// Uso: node scripts/gen-og-image.js
// Nota: se ejecuta en local (usa las fuentes del sistema). El PNG resultante se
// commitea y GitHub Pages lo copia tal cual; no se regenera en CI para que las
// fuentes no varíen el resultado entre sistemas.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = join(root, "assets", "og-image.svg");
const pngPath = join(root, "assets", "og-image.png");

const svg = readFileSync(svgPath, "utf8");
await sharp(Buffer.from(svg)).png().resize(1200, 630).toFile(pngPath);

const meta = await sharp(pngPath).metadata();
console.log(`OK: ${pngPath} (${meta.width}x${meta.height}, ${(meta.size / 1024).toFixed(0)} KB)`);
