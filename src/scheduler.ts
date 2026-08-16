import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChannelId } from "./types.js";

/** Franjas horarias recomendadas por plataforma (hora local del servidor).
 *  Prior base: se usa siempre que no haya datos reales suficientes. */
export const BEST_SLOTS: Record<ChannelId, { days: number[]; hours: number[] }> = {
  mastodon: { days: [1, 2, 3, 4, 5], hours: [8, 9, 10, 11, 12] },
  bluesky: { days: [1, 2, 3, 4, 5], hours: [9, 10, 11, 15, 16] },
  twitter: { days: [1, 2, 3, 4, 5], hours: [9, 10, 11, 12, 14, 15] },
  linkedin: { days: [2, 3, 4], hours: [8, 9, 10, 11, 17] },
  instagram: { days: [1, 2, 3, 4, 5, 6], hours: [11, 12, 13, 19, 20, 21] },
  facebook: { days: [3, 4, 5], hours: [15, 16, 17, 18, 19] },
  tiktok: { days: [1, 2, 3, 4, 5, 6, 0], hours: [12, 18, 19, 20, 21, 22] },
};

/** Horas/días máximos aprendidos y nº de muestras objetivo para dar prioridad a los datos. */
const MAX_LEARNED_HOURS = 6;
const MAX_LEARNED_DAYS = 5;
const TARGET_SAMPLES = 10;

export interface EngagementInput {
  likes?: number;
  reposts?: number;
  comments?: number;
  clicks?: number;
}

/** Un post publicado con su engagement, para aprender horarios. */
export interface LearnablePost {
  channel: ChannelId;
  /** Timestamp ISO de publicación. */
  publishedAt: string;
  engagement: EngagementInput;
}

/** Franjas aprendidas para un canal (vacío si no hay datos suficientes). */
export interface LearnedChannelSchedule {
  days: number[];
  hours: number[];
  /** Nº de posts con engagement usados. */
  samples: number;
  /** Engagement medio por post (likes + 2·reposts + 3·comentarios + clics). */
  avgEngagement: number;
}

export type LearnedSchedule = Partial<Record<ChannelId, LearnedChannelSchedule>>;

/** Peso del engagement: los comentarios y reposts valen más que un like. */
export function engagementScore(e: EngagementInput): number {
  return (e.likes ?? 0) + (e.reposts ?? 0) * 2 + (e.comments ?? 0) * 3 + (e.clicks ?? 0);
}

/** Aprende las mejores horas/días por canal a partir del engagement real.
 *  Combina el prior estático con los datos: con pocas muestras manda el prior;
 *  con suficientes, los datos. Devuelve solo canales con al menos 1 muestra. */
export function learnSchedule(posts: LearnablePost[]): LearnedSchedule {
  // Acumular score medio por (canal, hora) y (canal, día).
  const hourScores = new Map<string, { sum: number; count: number }>();
  const dayScores = new Map<string, { sum: number; count: number }>();
  const samples = new Map<ChannelId, number>();
  const totalScore = new Map<ChannelId, number>();

  for (const p of posts) {
    const d = new Date(p.publishedAt);
    if (Number.isNaN(d.getTime())) continue;
    const score = engagementScore(p.engagement);
    if (score <= 0) continue; // sin engagement no aporta señal
    const hourKey = `${p.channel}|${d.getHours()}`;
    const dayKey = `${p.channel}|${d.getDay()}`;
    bump(hourScores, hourKey, score);
    bump(dayScores, dayKey, score);
    samples.set(p.channel, (samples.get(p.channel) ?? 0) + 1);
    totalScore.set(p.channel, (totalScore.get(p.channel) ?? 0) + score);
  }

  const result: LearnedSchedule = {};
  for (const channel of Object.keys(BEST_SLOTS) as ChannelId[]) {
    const n = samples.get(channel) ?? 0;
    if (n === 0) continue;
    const prior = BEST_SLOTS[channel];
    const w = Math.min(1, n / TARGET_SAMPLES); // peso de los datos (0..1)

    // Horas: score normalizado por la mejor hora, mezclado con el prior.
    const hours: { h: number; score: number }[] = [];
    for (let h = 0; h < 24; h++) {
      const b = hourScores.get(`${channel}|${h}`);
      const learned = b ? b.sum / b.count : 0;
      const priorScore = prior.hours.includes(h) ? 1 : 0;
      hours.push({ h, score: priorScore * (1 - w) + learned * w });
    }
    const maxHour = Math.max(...hours.map((x) => x.score), 1e-9);
    const bestHours = hours
      .map((x) => ({ h: x.h, s: x.score / maxHour }))
      .filter((x) => x.s > 0.05)
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_LEARNED_HOURS)
      .map((x) => x.h)
      .sort((a, b) => a - b);

    // Días: igual que horas.
    const days: { d: number; score: number }[] = [];
    for (let d = 0; d < 7; d++) {
      const b = dayScores.get(`${channel}|${d}`);
      const learned = b ? b.sum / b.count : 0;
      const priorScore = prior.days.includes(d) ? 1 : 0;
      days.push({ d, score: priorScore * (1 - w) + learned * w });
    }
    const maxDay = Math.max(...days.map((x) => x.score), 1e-9);
    const bestDays = days
      .map((x) => ({ d: x.d, s: x.score / maxDay }))
      .filter((x) => x.s > 0.05)
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_LEARNED_DAYS)
      .map((x) => x.d)
      .sort((a, b) => a - b);

    result[channel] = {
      days: bestDays.length > 0 ? bestDays : [...prior.days],
      hours: bestHours.length > 0 ? bestHours : [...prior.hours],
      samples: n,
      avgEngagement: Math.round((totalScore.get(channel) ?? 0) / n),
    };
  }
  return result;
}

function bump(map: Map<string, { sum: number; count: number }>, key: string, score: number): void {
  const cur = map.get(key) ?? { sum: 0, count: 0 };
  cur.sum += score;
  cur.count++;
  map.set(key, cur);
}

/** Franjas que usa nextSlot: aprendidas si existen, si no el prior estático. */
export function scheduleFor(channel: ChannelId, learned?: LearnedSchedule): { days: number[]; hours: number[] } {
  const l = learned?.[channel];
  return l && l.hours.length > 0 ? l : BEST_SLOTS[channel];
}

/** Calcula el siguiente hueco de publicación para un canal, respetando:
 *  - el intervalo mínimo entre publicaciones (minIntervalMs)
 *  - las franjas horarias del canal (aprendidas del engagement si hay datos,
 *    prior estático en caso contrario)
 *  - un horizonte máximo (evita programar demasiado lejos)
 */
export function nextSlot(
  channel: ChannelId,
  after: Date,
  minIntervalMs: number,
  maxHorizonDays = 3,
  learned?: LearnedSchedule,
): Date {
  const slot = new Date(after.getTime() + minIntervalMs);
  const { days, hours } = scheduleFor(channel, learned);

  // Buscar la próxima franja válida (día + hora), probando hasta el horizonte.
  for (let dayOffset = 0; dayOffset <= maxHorizonDays * 2; dayOffset++) {
    const probe = new Date(slot);
    probe.setDate(probe.getDate() + dayOffset);
    const weekday = probe.getDay();
    if (!days.includes(weekday)) continue;
    for (const hour of hours) {
      const candidate = new Date(probe);
      candidate.setHours(hour, 0, 0, 0);
      if (candidate.getTime() > slot.getTime()) return candidate;
    }
  }
  // Fallback: simplemente respetar el intervalo mínimo.
  return slot;
}

/* ── Persistencia del modelo aprendido (data/schedule-learned.json) ── */

export function loadLearnedSchedule(file: string): LearnedSchedule {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LearnedSchedule;
  } catch {
    return {};
  }
}

export function saveLearnedSchedule(file: string, schedule: LearnedSchedule): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(schedule, null, 2));
}

/** Construye los LearnablePost a partir de los posts publicados del store
 *  y las métricas recopiladas (data/metrics.json). */
export function buildLearnablePosts(
  published: { channel: ChannelId; publishedAt?: string; id: string }[],
  metrics: { posts: Record<string, { engagement: EngagementInput }> },
): LearnablePost[] {
  return published
    .filter((p) => p.publishedAt && metrics.posts[p.id])
    .map((p) => ({
      channel: p.channel,
      publishedAt: p.publishedAt!,
      engagement: metrics.posts[p.id].engagement,
    }));
}
