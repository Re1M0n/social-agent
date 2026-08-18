import { PLATFORM_PROFILES } from "./agent/marketingAgent.js";
import type { AgentConfig } from "./config.js";
import type { ChannelId } from "./types.js";

/** Evento sobre el que avisar a los destinos configurados. */
export type NotifyEvent =
  | { kind: "publish"; channel: ChannelId; title: string; postUrl?: string }
  | { kind: "failure"; channel: ChannelId; title: string; error: string };

/** Tiempo máximo de espera por destino (no bloquear la publicación). */
const TIMEOUT_MS = 10_000;

function channelName(id: ChannelId): string {
  return PLATFORM_PROFILES[id]?.name ?? id;
}

/** Texto plano del aviso (funciona para webhook, Telegram y Discord). */
export function notifyText(ev: NotifyEvent): string {
  const title = ev.title.length > 120 ? `${ev.title.slice(0, 117)}…` : ev.title;
  if (ev.kind === "publish") {
    return `Social Agent · Publicado en ${channelName(ev.channel)}: ${title}${ev.postUrl ? `\n${ev.postUrl}` : ""}`;
  }
  return `Social Agent · Fallo al publicar en ${channelName(ev.channel)}: ${title}\n${ev.error}`;
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "SocialAgent/1.0" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Envía el aviso a todos los destinos configurados. Nunca lanza: los fallos
 *  de red se loguean y no bloquean la publicación. */
export async function sendNotifications(config: AgentConfig, ev: NotifyEvent): Promise<void> {
  const n = config.notifications;
  if (ev.kind === "publish" && !n.onPublish) return;
  if (ev.kind === "failure" && !n.onFailure) return;

  const jobs: { target: string; run: () => Promise<void> }[] = [];
  if (n.webhookUrl) {
    jobs.push({
      target: "webhook",
      run: () => post(n.webhookUrl, { text: notifyText(ev), event: ev.kind, channel: ev.channel }),
    });
  }
  if (n.telegramToken && n.telegramChatId) {
    jobs.push({
      target: "telegram",
      run: () =>
        post(`https://api.telegram.org/bot${n.telegramToken}/sendMessage`, {
          chat_id: n.telegramChatId,
          text: notifyText(ev),
        }),
    });
  }
  if (n.discordUrl) {
    jobs.push({
      target: "discord",
      run: () => post(n.discordUrl, { content: notifyText(ev) }),
    });
  }

  await Promise.all(
    jobs.map((j) =>
      j.run().catch((err: unknown) => {
        console.error(`[notify:${j.target}] ${err instanceof Error ? err.message : String(err)}`);
      }),
    ),
  );
}
