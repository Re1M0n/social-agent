#!/usr/bin/env node
import { watch } from "chokidar";
import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { startPanel } from "./panel/server.js";
import { generateEditorialPlan, generateWeeklyReport, type EditorialPlanContext, type WeeklyReportContext } from "./agent/marketingAgent.js";
import { fetchFollowers, fetchPostEngagement, loadManualMetrics, MetricsStore } from "./metrics.js";
import { nextSlot } from "./scheduler.js";
import { generateImage } from "./mediaGen.js";
import { publishDue, scheduleDrafts } from "./publisher.js";
import { Store } from "./storage.js";
import { CHANNELS, type ChannelId } from "./types.js";
import { generateForAll } from "./generator.js";
import { ingest } from "./ingest.js";

const HELP = `Social Agent — Agente de marketing en redes sociales

Uso:
  social-agent <comando>

Comandos:
  ingest     Escanea content/ideas y content/media y registra contenido nuevo
  generate   Genera borradores (drafts) por plataforma para el contenido nuevo
  publish    Publica los posts programados que ya tocan (o --force todos los drafts)
  serve      Modo autónomo: vigila las carpetas, genera y publica solo
  status     Muestra el estado de la cola y los posts
  channels   Lista los canales y si están configurados
  media-urls Muestra las URLs públicas de cada archivo de media y verifica acceso
  metrics    Recopila seguidores y engagement por canal (en vivo + manual)
  calendar   Calendario editorial de la semana (--md exporta a markdown)
  report     Genera el informe semanal de rendimiento (agente LLM)
  plan       Genera el plan editorial semanal (pilares + calendario, agente LLM)
  gen-image  Genera una imagen gratis para un ítem o un prompt (Pollinations/HF)
  panel      Abre el panel web para revisar, editar y aprobar drafts

Servidor de media (para Instagram/TikTok):
  npm run serve:media   → sirve content/media en http://localhost:8787

Opciones:
  --force    En publish: publica también drafts sin programar y reintenta fallidos
  --dry-run  Fuerza modo simulación (no toca APIs reales)
  --no-dry   Fuerza modo real aunque DRY_RUN=1 en .env

  PUBLIC_MEDIA_BASE_URL   → base URL pública para construir las URLs de media

Configuración: copia .env.example a .env y rellena las credenciales.
Contenido:   deja ideas (.md) en content/ideas y media en content/media.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";

  // Sobrescribir DRY_RUN según flags antes de cargar config.
  if (args.includes("--dry-run")) process.env.DRY_RUN = "1";
  if (args.includes("--no-dry")) process.env.DRY_RUN = "0";

  const config = loadConfig();
  const store = new Store(config.dataFile);

  switch (command) {
    case "ingest": {
      const added = ingest(config, store);
      if (added.length === 0) {
        console.log("No hay contenido nuevo. Deja ideas en content/ideas/ y media en content/media/.");
      }
      for (const item of added) {
        console.log(`  ✓ [${item.kind}] ${item.title}${item.filePath ? ` (${item.filePath})` : ""}`);
      }
      printStats(store);
      break;
    }

    case "generate": {
      const { generated, itemsProcessed } = await generateForAll(config, store);
      console.log(
        generated > 0
          ? `✓ Generados ${generated} drafts para ${itemsProcessed} ítem(s).`
          : "Sin drafts nuevos. Ejecuta 'ingest' primero o añade contenido.",
      );
      if (!config.llm.enabled) {
        console.log("ℹ️  LLM desactivado (falta LLM_API_KEY): se usaron plantillas. Actívalo en .env para contenido experto.");
      }
      break;
    }

    case "publish": {
      const force = args.includes("--force");
      if (!force) {
        const scheduled = store.getPostsByStatus("scheduled");
        const drafts = store.getPostsByStatus("draft");
        if (scheduled.length === 0 && drafts.length > 0 && !config.autoPublish) {
          console.log(
            `Hay ${drafts.length} draft(s) sin programar. Usa 'publish --force' o activa AUTO_PUBLISH=1 en .env.`,
          );
          break;
        }
      }
      const outcome = await publishDue(config, store, force);
      logOutcome(outcome);
      break;
    }

    case "serve": {
      console.log(
        `🤖 Modo autónomo activo. Vigilando ${config.contentDir} (autoPublish=${config.autoPublish ? "sí" : "no"}, dryRun=${config.dryRun ? "sí" : "no"})`,
      );
      // Ejecución inicial.
      const added = ingest(config, store);
      if (added.length > 0) console.log(`  ✓ Ingesta inicial: ${added.length} ítem(s) nuevo(s).`);
      const { generated } = await generateForAll(config, store);
      if (generated > 0) console.log(`  ✓ Generados ${generated} draft(s).`);
      await runCycle(config, store);

      // Vigilancia.
      const onEvent = async (path: string) => {
        if (!existsSync(path)) return;
        console.log(`\n📁 Cambio detectado: ${path}`);
        const addedNow = ingest(config, store);
        if (addedNow.length > 0) {
          for (const item of addedNow) console.log(`  ✓ Nuevo: ${item.title}`);
          const { generated: g } = await generateForAll(config, store);
          if (g > 0) console.log(`  ✓ Generados ${g} draft(s).`);
        }
        await runCycle(config, store);
      };
      watch([config.ideasDir, config.mediaDir], { ignoreInitial: true })
        .on("add", onEvent)
        .on("change", onEvent);

      // Timer: publica lo que toque aunque no haya cambios de archivo.
      setInterval(async () => {
        await publishDue(config, store);
      }, 30_000);
      console.log("Ctrl+C para salir. Revisa cada 30s los posts programados.");
      break;
    }

    case "status": {
      printStats(store);
      const posts = store.posts;
      for (const p of posts.slice().reverse()) {
        const item = store.getContentItem(p.contentItemId);
        const when = p.publishedAt ?? p.scheduledFor ?? p.createdAt;
        const url = p.postUrl ? ` (${p.postUrl})` : "";
        const err = p.error ? ` — ${p.error}` : "";
        console.log(
          `  [${p.status.padEnd(9)}] ${p.channel.padEnd(9)} ${when.slice(0, 19)} «${truncate(p.text, 40)}»${url}${err}`,
        );
        if (item) console.log(`         ↳ fuente: ${item.title}`);
      }
      break;
    }

    case "plan": {
      await runPlan(config, store);
      break;
    }

    case "gen-image": {
      const rest = args.slice(1).join(" ").trim();
      await runGenImage(config, store, rest);
      break;
    }

    case "panel": {
      const port = Number(process.env.PANEL_PORT ?? 4000);
      try {
        startPanel(config, port);
        console.log(`🖥️  Panel de revisión en http://localhost:${port}`);
        console.log("Revisa, edita y aprueba drafts antes de publicar. Ctrl+C para salir.");
      } catch (err) {
        console.error(`No se pudo arrancar el panel en el puerto ${port}:`, err instanceof Error ? err.message : err);
        console.error("Prueba con otro puerto: PANEL_PORT=5000 npm run panel");
        process.exit(1);
      }
      break;
    }

    case "metrics": {
      await runMetrics(config, store);
      break;
    }

    case "calendar": {
      const asMd = args.includes("--md");
      const calendar = buildCalendar(config, store);
      if (asMd) {
        const file = "content/calendario-editorial.md";
        writeFileSync(file, calendar, "utf8");
        console.log(`✓ Calendario exportado a ${file}`);
      } else {
        console.log(calendar);
      }
      break;
    }

    case "report": {
      await runReport(config, store);
      break;
    }

    case "media-urls": {
      await printMediaUrls(config, store);
      break;
    }

    case "channels": {
      for (const id of CHANNELS) {
        const cfg = config.channels[id];
        const creds = Object.entries(cfg.credentials)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ");
        console.log(
          `  ${cfg.enabled ? "✓" : "✗"} ${id.padEnd(9)} ${cfg.enabled ? "habilitado" : "deshabilitado"}${creds ? ` (${creds})` : ""}`,
        );
      }
      break;
    }

    case "help":
    case "-h":
    case "--help":
    default:
      console.log(HELP);
  }
}

async function runCycle(config: ReturnType<typeof loadConfig>, store: Store): Promise<void> {
  if (config.autoPublish) {
    const scheduled = scheduleDrafts(config, store);
    if (scheduled > 0) console.log(`  🕐 Programados ${scheduled} post(s) en horarios óptimos.`);
  }
  const outcome = await publishDue(config, store);
  if (outcome.published + outcome.failed + outcome.skipped > 0) logOutcome(outcome);
}

function logOutcome(outcome: { published: number; failed: number; skipped: number; dryRun: boolean }): void {
  const mode = outcome.dryRun ? " [dry-run]" : "";
  console.log(
    `✓ Publicados: ${outcome.published} | Fallidos: ${outcome.failed} | Saltados: ${outcome.skipped}${mode}`,
  );
  if (outcome.dryRun && outcome.published > 0) {
    console.log("ℹ️  Modo simulación: nada se publicó de verdad. Quita DRY_RUN=1 del .env cuando estés listo.");
  }
}

function printStats(store: Store): void {
  const s = store.stats();
  console.log(
    `📊 ${s.items} ítems | ${s.drafts} drafts | ${s.scheduled} programados | ${s.published} publicados | ${s.failed} fallidos`,
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/* ── Plan editorial semanal ─────────────────────────────────── */

async function runPlan(config: ReturnType<typeof loadConfig>, store: Store): Promise<void> {
  const { weekStart, weekEnd } = weekRange(new Date());
  const ctx: EditorialPlanContext = {
    weekStart: weekStart.toISOString().slice(0, 10),
    weekEnd: weekEnd.toISOString().slice(0, 10),
    items: store.contentItems.map((i) => ({ title: i.title, kind: i.kind })),
    channelsEnabled: (Object.keys(config.channels) as ChannelId[]).filter((id) => config.channels[id].enabled),
  };
  const { plan, usedLlm } = await generateEditorialPlan(config, ctx);
  const { year, week } = isoWeek(new Date());
  mkdirSync("reports", { recursive: true });
  const file = `reports/plan-${year}-W${String(week).padStart(2, "0")}.md`;
  writeFileSync(file, plan + "\n", "utf8");
  console.log(`✓ Plan editorial guardado en ${file}${usedLlm ? " (generado por el agente LLM)" : " (plantilla)"}`);
  console.log(plan.slice(0, 1200) + (plan.length > 1200 ? "\n…" : ""));
}

/* ── Generación de imágenes gratuitas ───────────────────────── */

async function runGenImage(config: ReturnType<typeof loadConfig>, store: Store, arg: string): Promise<void> {
  // Si el argumento es un id de contenido existente, usa su título+cuerpo como prompt.
  let prompt = arg;
  if (arg && store.getContentItem(arg)) {
    const item = store.getContentItem(arg)!;
    prompt = `${item.title}. ${item.body ?? ""}`.trim();
    console.log(`🎨 Generando imagen para: ${item.title}`);
  } else if (arg) {
    console.log(`🎨 Generando imagen para el prompt: ${arg}`);
  } else {
    console.log(
      "Uso: gen-image [id-de-contenido] [prompt libre]\n" +
        "  node dist/cli.js gen-image <id>        → imagen del ítem\n" +
        "  node dist/cli.js gen-image 'texto'     → imagen del prompt",
    );
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = `${config.mediaDir}/gen-${stamp}.png`;
  try {
    const saved = await generateImage(prompt, out, config.llm.apiKey && process.env.HF_TOKEN);
    const size = Math.round((await import("node:fs")).statSync(saved).size / 1024) + " KB";
    console.log(`✓ Imagen guardada en ${saved} (${size})`);
    console.log("Ejecuta 'npm run ingest' para registrarla como media, o úsala en tus posts.");
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    console.error("Sin clave usa Pollinations (gratis, sin registro). Con HF_TOKEN usa Hugging Face.");
  }
}

/* ── Calendario editorial ───────────────────────────────────── */

/** Construye la vista del calendario: posts de la semana + huecos recomendados. */
function buildCalendar(config: ReturnType<typeof loadConfig>, store: Store): string {
  const now = new Date();
  const { weekStart, weekEnd } = weekRange(now);
  const lines: string[] = [];
  lines.push(`# 📅 Calendario editorial (semana ${isoWeek(now).week} de ${now.getFullYear()})`);
  lines.push(`**${fmtDate(weekStart)} → ${fmtDate(weekEnd)}**\n`);

  const weekPosts = store.posts
    .filter((p) => {
      const d = p.publishedAt ?? p.scheduledFor;
      if (!d) return false;
      const t = Date.parse(d);
      return t >= weekStart.getTime() && t <= weekEnd.getTime();
    })
    .sort((a, b) => (a.publishedAt ?? a.scheduledFor ?? "").localeCompare(b.publishedAt ?? b.scheduledFor ?? ""));

  if (weekPosts.length === 0) {
    lines.push("_Sin posts en esta semana todavía._");
  } else {
    lines.push("## Posts de la semana\n");
    for (const p of weekPosts) {
      const date = new Date(p.publishedAt ?? p.scheduledFor!);
      const status = p.status === "published" ? "✅" : p.status === "failed" ? "❌" : "🕐";
      lines.push(
        `- ${status} **${fmtDate(date)} ${fmtTime(date)}** · ${p.channel} · ${truncate(p.text, 70)}`,
      );
    }
  }

  // Huecos recomendados: próximos 3 slots por canal habilitado.
  const enabled = (Object.keys(config.channels) as ChannelId[]).filter((id) => config.channels[id].enabled);
  lines.push("\n## Huecos recomendados (próximas publicaciones)\n");
  for (const channel of enabled) {
    let after = new Date();
    const slots: string[] = [];
    for (let i = 0; i < 3; i++) {
      const slot = nextSlot(channel, after, config.minIntervalMs);
      slots.push(`${fmtDate(slot)} ${fmtTime(slot)}`);
      after = new Date(slot.getTime() + config.minIntervalMs);
    }
    lines.push(`- **${channel}**: ${slots.join(" → ")}`);
  }
  lines.push("\n_Generado por Social Agent._");
  return lines.join("\n");
}

/** Lunes 00:00 → domingo 23:59 de la semana que contiene `date`. */
function weekRange(date: Date): { weekStart: Date; weekEnd: Date } {
  const d = new Date(date);
  const day = d.getDay();
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const weekStart = new Date(d);
  weekStart.setDate(d.getDate() + diffToMonday);
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);
  return { weekStart, weekEnd };
}

/** Número de semana ISO 8601. */
function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("es-ES", { weekday: "short", day: "2-digit", month: "short" });
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

/* ── Métricas por canal ─────────────────────────────────────── */

async function runMetrics(config: ReturnType<typeof loadConfig>, store: Store): Promise<void> {
  const metrics = new MetricsStore(config.dataFile.replace(/agent\.json$/, "metrics.json"));
  const manual = loadManualMetrics(config.dataFile.replace(/agent\.json$/, "metrics-manual.json"));

  // Seguidores manuales primero (para canales sin API).
  for (const [channel, count] of Object.entries(manual.followers ?? {})) {
    if (count !== undefined) metrics.setFollowers(channel as ChannelId, count);
  }

  // Seguidores en vivo (Mastodon, Bluesky) y engagement de posts publicados.
  const published = store.getPostsByStatus("published");
  for (const id of CHANNELS) {
    const cfg = config.channels[id];
    if (!cfg.enabled) continue;
    const followers = await fetchFollowers(id, cfg);
    if (followers !== undefined) metrics.setFollowers(id, followers);
  }

  for (const post of published) {
    const cfg = config.channels[post.channel];
    const manualEng = manual.posts?.[post.id];
    if (manualEng) {
      metrics.setPostMetrics(post.id, {
        channel: post.channel,
        url: post.postUrl,
        engagement: manualEng,
        fetchedAt: new Date().toISOString(),
      });
      continue;
    }
    const engagement = await fetchPostEngagement(post, cfg);
    if (engagement) {
      metrics.setPostMetrics(post.id, {
        channel: post.channel,
        url: post.postUrl,
        engagement,
        fetchedAt: new Date().toISOString(),
      });
    }
  }

  // Tabla.
  console.log("📊 Métricas por canal (guardadas en data/metrics.json)\n");
  for (const id of CHANNELS) {
    if (!config.channels[id].enabled) continue;
    const f = metrics.data.followers[id];
    const posts = Object.values(metrics.data.posts).filter((p) => p.channel === id);
    const likes = posts.reduce((a, p) => a + (p.engagement.likes ?? 0), 0);
    const reposts = posts.reduce((a, p) => a + (p.engagement.reposts ?? 0), 0);
    const comments = posts.reduce((a, p) => a + (p.engagement.comments ?? 0), 0);
    const clicks = posts.reduce((a, p) => a + (p.engagement.clicks ?? 0), 0);
    console.log(
      `  ${id.padEnd(9)} seguidores: ${f?.count ?? "—".padEnd(4)}  posts: ${posts.length}  likes: ${likes}  reposts: ${reposts}  comentarios: ${comments}  clics: ${clicks}`,
    );
  }
  console.log(
    "\nℹ️  Mastodon y Bluesky se consultan en vivo. Para X/LinkedIn/IG/FB/TikTok introduce" +
      "\n   los datos en data/metrics-manual.json (ver README).",
  );
}

/* ── Informe semanal ────────────────────────────────────────── */

async function runReport(config: ReturnType<typeof loadConfig>, store: Store): Promise<void> {
  const metrics = new MetricsStore(config.dataFile.replace(/agent\.json$/, "metrics.json"));
  const { weekStart, weekEnd } = weekRange(new Date());

  const posts = store.posts
    .filter((p) => {
      if (!p.publishedAt) return false;
      const t = Date.parse(p.publishedAt);
      return t >= weekStart.getTime() && t <= weekEnd.getTime();
    })
    .map((p) => {
      const m = metrics.data.posts[p.id];
      return {
        channel: p.channel,
        text: p.text,
        publishedAt: p.publishedAt,
        postUrl: p.postUrl,
        likes: m?.engagement.likes,
        reposts: m?.engagement.reposts,
        comments: m?.engagement.comments,
        clicks: m?.engagement.clicks,
      };
    });

  const ctx: WeeklyReportContext = {
    weekStart: weekStart.toISOString().slice(0, 10),
    weekEnd: weekEnd.toISOString().slice(0, 10),
    posts,
    followers: metrics.data.followers,
    channelsEnabled: (Object.keys(config.channels) as ChannelId[]).filter((id) => config.channels[id].enabled),
  };

  const { report, usedLlm } = await generateWeeklyReport(config, ctx);
  const { year, week } = isoWeek(new Date());
  mkdirSync("reports", { recursive: true });
  const file = `reports/${year}-W${String(week).padStart(2, "0")}.md`;
  writeFileSync(file, report + "\n", "utf8");
  console.log(`✓ Informe semanal guardado en ${file}${usedLlm ? " (generado por el agente LLM)" : " (plantilla)"}`);
  console.log(report.slice(0, 1200) + (report.length > 1200 ? "\n…" : ""));
}

/** Muestra las URLs públicas de cada archivo de media y verifica su accesibilidad. */
async function printMediaUrls(config: ReturnType<typeof loadConfig>, store: Store): Promise<void> {
  const base =
    process.env.PUBLIC_MEDIA_BASE_URL ??
    process.env.INSTAGRAM_MEDIA_BASE_URL ??
    process.env.TIKTOK_MEDIA_BASE_URL;
  const media = store.contentItems.filter((i) => i.kind === "media");

  if (!base) {
    console.log(
      "Define PUBLIC_MEDIA_BASE_URL (o INSTAGRAM_MEDIA_BASE_URL / TIKTOK_MEDIA_BASE_URL) en .env.\n" +
        "Si pruebas en local: arranca el servidor con 'npm run serve:media' y usa http://localhost:8787.\n" +
        "⚠️  Para publicar en Instagram/TikTok de verdad, la URL debe ser pública (ngrok, VPS, CDN…).",
    );
    return;
  }

  const baseClean = base.replace(/\/+$/, "");
  console.log(`Base de media: ${baseClean}`);
  if (media.length === 0) {
    console.log("No hay archivos de media en el store. Ejecuta 'ingest' antes.");
    return;
  }

  for (const item of media) {
    const fileName = item.filePath?.split(/[\\/]/).pop();
    if (!fileName) continue;
    const url = `${baseClean}/${encodeURIComponent(fileName)}`;
    let reachable = "❓";
    try {
      const res = await fetch(url, { method: "HEAD" });
      reachable = res.ok ? "✅ accesible" : `❌ HTTP ${res.status}`;
    } catch {
      reachable = "❌ no responde";
    }
    console.log(`  ${item.title.padEnd(20)} ${url}  ${reachable}`);
  }
  console.log(
    "\n💡 Recuerda: si usas localhost, Instagram/TikTok no podrán alcanzarla. " +
      "Usa un túnel público (ngrok) o un hosting para la carpeta content/media.",
  );
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
