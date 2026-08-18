import { PLATFORM_PROFILES } from "./agent/marketingAgent.js";
import type { AgentConfig } from "./config.js";
import type { ChannelId } from "./types.js";

/** Evento sobre el que avisar a los destinos configurados. */
export type NotifyEvent =
  | { kind: "publish"; channel: ChannelId; title: string; postUrl?: string }
  | { kind: "failure"; channel: ChannelId; title: string; error: string };

/** Resultado por destino de un envío (publicación, fallo o prueba). */
export interface NotifyResult {
  /** id estable del destino: "webhook" | "telegram" | "discord" */
  target: string;
  /** nombre legible para mostrar en el panel */
  label: string;
  ok: boolean;
  error?: string;
}

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

/** Texto del aviso de prueba (con hora local para comprobar latencia). */
export function testNotifyText(): string {
  const when = new Date().toLocaleString();
  return `Social Agent · 🔔 Aviso de prueba — si recibes esto, las notificaciones funcionan (${when}).`;
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

interface Job {
  target: string;
  label: string;
  run: () => Promise<void>;
}

function buildJobs(n: AgentConfig["notifications"], text: string, meta: { event: string; channel: string }): Job[] {
  const jobs: Job[] = [];
  if (n.webhookUrl) {
    jobs.push({
      target: "webhook",
      label: "Webhook genérico",
      run: () => post(n.webhookUrl, { text, event: meta.event, channel: meta.channel }),
    });
  }
  if (n.telegramToken && n.telegramChatId) {
    jobs.push({
      target: "telegram",
      label: "Telegram",
      run: () =>
        post(`https://api.telegram.org/bot${n.telegramToken}/sendMessage`, {
          chat_id: n.telegramChatId,
          text,
        }),
    });
  }
  if (n.discordUrl) {
    jobs.push({
      target: "discord",
      label: "Discord",
      run: () => post(n.discordUrl, { content: text }),
    });
  }
  return jobs;
}

/** Ejecuta los envíos en paralelo. Nunca lanza: cada destino devuelve su
 *  resultado (ok/error) y los fallos de red se loguean. */
async function runJobs(jobs: Job[]): Promise<NotifyResult[]> {
  return Promise.all(
    jobs.map(async (j) => {
      try {
        await j.run();
        return { target: j.target, label: j.label, ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[notify:${j.target}] ${msg}`);
        return { target: j.target, label: j.label, ok: false, error: msg };
      }
    }),
  );
}

/** Envía el aviso a todos los destinos configurados según el evento. */
export async function sendNotifications(config: AgentConfig, ev: NotifyEvent): Promise<NotifyResult[]> {
  const n = config.notifications;
  if (ev.kind === "publish" && !n.onPublish) return [];
  if (ev.kind === "failure" && !n.onFailure) return [];
  return runJobs(buildJobs(n, notifyText(ev), { event: ev.kind, channel: ev.channel }));
}

/** Envía un aviso de prueba a todos los destinos configurados. */
export async function sendTestNotifications(config: AgentConfig): Promise<NotifyResult[]> {
  return runJobs(buildJobs(config.notifications, testNotifyText(), { event: "test", channel: "test" }));
}
