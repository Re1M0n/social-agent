import type { ChannelId } from "./types.js";

/** Franjas horarias recomendadas por plataforma (hora local del servidor). */
const BEST_SLOTS: Record<ChannelId, { days: number[]; hours: number[] }> = {
  mastodon: { days: [1, 2, 3, 4, 5], hours: [8, 9, 10, 11, 12] },
  bluesky: { days: [1, 2, 3, 4, 5], hours: [9, 10, 11, 15, 16] },
  twitter: { days: [1, 2, 3, 4, 5], hours: [9, 10, 11, 12, 14, 15] },
  linkedin: { days: [2, 3, 4], hours: [8, 9, 10, 11, 17] },
  instagram: { days: [1, 2, 3, 4, 5, 6], hours: [11, 12, 13, 19, 20, 21] },
  facebook: { days: [3, 4, 5], hours: [15, 16, 17, 18, 19] },
  tiktok: { days: [1, 2, 3, 4, 5, 6, 0], hours: [12, 18, 19, 20, 21, 22] },
};

/** Calcula el siguiente hueco de publicación para un canal, respetando:
 *  - el intervalo mínimo entre publicaciones (minIntervalMs)
 *  - las franjas horarias recomendadas del canal
 *  - un horizonte máximo (evita programar demasiado lejos)
 */
export function nextSlot(
  channel: ChannelId,
  after: Date,
  minIntervalMs: number,
  maxHorizonDays = 3,
): Date {
  const slot = new Date(after.getTime() + minIntervalMs);
  const { days, hours } = BEST_SLOTS[channel];

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
