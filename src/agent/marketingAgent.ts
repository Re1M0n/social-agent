import type { AgentConfig } from "../config.js";
import { chat, extractJson, type LlmOptions } from "../llm.js";
import type { ChannelId, ContentItem, Draft } from "../types.js";
import { CHANNELS } from "../types.js";

/** Perfiles de cada plataforma: tono, formato, límites y mejores prácticas. */
export const PLATFORM_PROFILES: Record<
  ChannelId,
  { name: string; charLimit: number; style: string; bestPractices: string }
> = {
  mastodon: {
    name: "Mastodon",
    charLimit: 500,
    style: "Cálido, comunitario y conversacional. Menos hashtags (2-4) y siempre aportar valor.",
    bestPractices:
      "Publica en horario de mañana. Usa hashtags discretos al final. Favorece la conversación (CWs para spoilers).",
  },
  bluesky: {
    name: "Bluesky",
    charLimit: 300,
    style: "Directo, ingenioso, auténtico. Sin clickbait. Público técnico-creativo.",
    bestPractices:
      "Los hashtags funcionan pero con moderación. Mejor un titular potente + call to action. El humor funciona bien.",
  },
  twitter: {
    name: "X (Twitter)",
    charLimit: 280,
    style: "Conciso, punzante, con gancho en la primera línea. Hilos para contenido largo.",
    bestPractices:
      "Primera frase que enganche. Máximo 2-3 hashtags. Mejor horario: laborables 9-15h. Incluir CTA o pregunta.",
  },
  linkedin: {
    name: "LinkedIn",
    charLimit: 3000,
    style: "Profesional, con storytelling y aprendizaje. Primera línea en mayúsculas o llamativa para cortar el 'ver más'.",
    bestPractices:
      "Publica martes-jueves 8-10h. Frases cortas, párrafos de 2-3 líneas. Termina con pregunta para engagement. Mínimo 3 hashtags relevantes.",
  },
  instagram: {
    name: "Instagram",
    charLimit: 2200,
    style: "Emocional y visual. Caption que complementa la imagen/video, con CTA claro y emojis medidos.",
    bestPractices:
      "Primera línea antes del salto de línea debe enganchar. 5-10 hashtags mezclando tamaño. Stories para amplificar. Mejor horario: 11-13h y 19-21h.",
  },
  facebook: {
    name: "Facebook",
    charLimit: 63206,
    style: "Cercano y accesible, tono conversacional. El texto breve funciona mejor; el video nativo manda.",
    bestPractices:
      "Preguntas abiertas generan comentarios. 1-3 hashtags. Mejor horario: miércoles y jueves por la tarde.",
  },
  tiktok: {
    name: "TikTok",
    charLimit: 2200,
    style: "Energético, nativo de vídeo corto. Caption corta + gancho en los 3 primeros segundos del vídeo.",
    bestPractices:
      "Usa sonidos/trends. Hashtags: 3-5 mezclando nicho y volumen. Publica 2-3 veces/día. El texto en pantalla ayuda al alcance.",
  },
};

const SYSTEM_PROMPT = `Eres un estratega senior de marketing y copywriter en redes sociales con 15 años de experiencia.

Tu trabajo: convertir ideas base y archivos de media en publicaciones listas para publicar,
adaptadas a cada plataforma según sus códigos, límites de caracteres y mejores prácticas.

TÉCNICAS DE COPYWRITING QUE DEBES APLICAR SIEMPRE:
- Gancho en la primera línea. Fórmulas: cifra llamativa ("3 lecciones que me costaron un año"),
  pregunta incómoda ("¿Por qué nadie te dice esto?"), afirmación audaz ("Tu estrategia está mal desde la base"),
  curiosidad incompleta ("Lo que nadie te cuenta de..."), o beneficio concreto ("Planifica tu día en 60 segundos").
  Prohibido empezar con muletillas tipo "Hoy te voy a contar" o "En este post".
- Estructura AIDA cuando el texto lo permite (Atención → Interés → Deseo → Acción).
- Estructura PAS para contenido de dolor/solución (Problema → Agitar → Solución).
- Especificidad: números, datos y detalles concretos convierten más que lo abstracto.
- Palabras de poder y escasez con moderación ("gratis", "limitado", "secreto", "error", "nunca", "nadie") solo si son verdaderas.
- Call to action variado: pregunta abierta, invitación a comentar, enlace, "guárdalo para después" — evita repetir el mismo CTA en todas las plataformas.
- Tono auténtico y humano: sin relleno, sin frases genéricas de IA, sin "descubre/explora" repetido.

REGLA DE ORO DEL GANCHO: para cada plataforma, escribe 3 ganchos/titulares distintos
(campo "variants"), cada uno con una fórmula diferente (p. ej. cifra, pregunta, afirmación
audaz). El campo "text" es la versión principal completa; los "variants" son versiones
completas alternativas listas para publicar tal cual (mismo cuerpo, distinto gancho).

Reglas de oro:
1. Una idea → una publicación por plataforma. No copies/pegues: adapta el enfoque al público de cada canal.
2. Cada publicación debe tener un objetivo claro (informar, inspirar, vender, generar conversación).
3. Los hashtags deben ser relevantes y específicos, respetando el límite de cada plataforma.
4. Si el contenido incluye media, describe cómo aprovecharla (el texto debe complementar la imagen/vídeo).
5. Responde SIEMPRE con JSON válido, con una clave "posts" que es un array.`;

function userPrompt(item: ContentItem, channels: ChannelId[]): string {
  const profiles = channels
    .map(
      (c) =>
        `## ${PLATFORM_PROFILES[c].name}\n` +
        `- Límite: ${PLATFORM_PROFILES[c].charLimit} caracteres\n` +
        `- Estilo: ${PLATFORM_PROFILES[c].style}\n` +
        `- Mejores prácticas: ${PLATFORM_PROFILES[c].bestPractices}`,
    )
    .join("\n\n");

  const mediaInfo = item.mediaType !== "text"
    ? `\n\nMEDIA ADJUNTA: ${item.mediaType} — ${item.body ?? item.filePath ?? ""}`
    : "";

  return `CONTENIDO BASE:
Título: ${item.title}
${item.body ? `Descripción/idea: ${item.body}` : ""}
${mediaInfo}

Genera una publicación para cada una de estas plataformas:
${profiles}

Formato JSON de respuesta (sin markdown alrededor):
{
  "posts": [
    {
      "channel": "mastodon",
      "text": "versión principal completa",
      "variants": ["gancho A + mismo cuerpo", "gancho B + mismo cuerpo", "gancho C + mismo cuerpo"],
      "tags": ["hashtag1", "hashtag2"],
      "rationale": "1 línea sobre la estrategia elegida"
    }
  ]
}

Cada "text" y cada "variant" debe respetar el límite de caracteres de su plataforma.`;
}

interface LlmPost {
  channel: string;
  text: string;
  variants?: string[];
  tags?: string[];
  rationale?: string;
}

/** Genera drafts para las plataformas indicadas usando el LLM configurado. */
export async function generateWithLlm(
  config: AgentConfig,
  item: ContentItem,
  channels: ChannelId[],
): Promise<Draft[]> {
  const opts: LlmOptions = {
    baseUrl: config.llm.baseUrl,
    apiKey: config.llm.apiKey ?? "",
    model: config.llm.model,
    temperature: 0.8,
  };
  const raw = await chat(opts, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt(item, channels) },
  ]);
  const parsed = extractJson<{ posts: LlmPost[] }>(raw);
  const now = new Date().toISOString();
  return parsed.posts
    .filter((p) => (channels as string[]).includes(p.channel))
    .map((p) => ({
      id: `post-${item.id}-${p.channel}`,
      contentItemId: item.id,
      channel: p.channel as ChannelId,
      text: p.text.trim(),
      variants: (p.variants ?? []).map((v) => v.trim()).filter(Boolean),
      tags: p.tags,
      rationale: p.rationale,
      mediaPaths: item.filePath ? [item.filePath] : undefined,
      createdAt: now,
    }));
}

/** Generador de respaldo sin LLM: plantillas de calidad para cada plataforma.
 *  Garantiza que el sistema funcione end-to-end aunque no haya API key. */
export function generateWithTemplates(item: ContentItem, channels: ChannelId[]): Draft[] {
  const now = new Date().toISOString();
  const title = item.title;
  // Para ítems de media, el cuerpo es metadatos internos: no debe filtrarse al texto.
  const body = item.kind === "idea" ? (item.body ?? "") : "";
  const mediaEmoji = item.mediaType === "video" ? " 🎬" : item.mediaType === "photo" ? " 📷" : item.mediaType === "audio" ? " 🎙️" : "";
  const hashtags = buildHashtags(title, body);

  const templates: Record<ChannelId, string> = {
    mastodon: `${title}${mediaEmoji}

${firstSentence(body)}

${hashtags.slice(0, 3).map((h) => `#${h}`).join(" ")}`,
    bluesky: `${title}${mediaEmoji} — ${firstSentence(body)}`,
    twitter: `${title}${mediaEmoji}: ${shorten(firstSentence(body), 220)}`,
    linkedin: `¿${title}? Te lo cuento en 30 segundos.

${shorten(body, 900) || (item.kind === "media" ? "Imagen y video que valen más que mil palabras." : "Este contenido puede cambiar cómo trabajas.")}

👉 ¿Ya lo aplicas en tu día a día? Cuéntamelo en comentarios.

${hashtags.slice(0, 4).map((h) => `#${h}`).join(" ")}`,
    instagram: `${title}${mediaEmoji}

${shorten(body, 600) || "Detalles que marcan la diferencia."}

👇 Cuéntame: ¿qué es lo que más te ha llamado la atención?

${hashtags.slice(0, 8).map((h) => `#${h}`).join(" ")}`,
    facebook: `${title}${mediaEmoji}

${shorten(body, 800) || "A veces lo simple funciona mejor."}

¿Qué opinas? Te leo en comentarios.`,
    tiktok: `${title}${mediaEmoji}

${shorten(firstSentence(body), 200)}

#fyp ${hashtags.slice(0, 3).map((h) => `#${h}`).join(" ")}`,
  };

  return channels.map((channel) => {
    const main = templates[channel].trim();
    return {
      id: `post-${item.id}-${channel}`,
      contentItemId: item.id,
      channel,
      text: main,
      // Variantes A/B de gancho (3 fórmulas distintas) listas para publicar.
      variants: buildVariants(main, title, body, channel, mediaEmoji, hashtags),
      tags: hashtags,
      rationale: "Generado con plantilla (modo sin LLM). Activa LLM_API_KEY para contenido experto.",
      mediaPaths: item.filePath ? [item.filePath] : undefined,
      createdAt: now,
    };
  });
}

/** Genera 3 variantes A/B del gancho con fórmulas de copywriting distintas. */
function buildVariants(
  main: string,
  title: string,
  body: string,
  channel: ChannelId,
  mediaEmoji: string,
  hashtags: string[],
): string[] {
  const rest = main.split("\n").slice(1).join("\n");
  const s = firstSentence(body);
  const hooks = [
    `¿${title}?${s ? ` La respuesta corta: ${shorten(s, 80)}` : ""}`,
    `${title}${mediaEmoji}: esto te ahorra horas`,
    `Nadie te lo dice, pero ${title.toLowerCase()}${s ? ` (${shorten(s, 70)})` : ""}`,
  ];
  const htags = hashtags.slice(0, 3).map((h) => `#${h}`).join(" ");
  return hooks.map((hook) => [hook, rest].filter(Boolean).join("\n\n") + (htags ? `\n\n${htags}` : "")).slice(0, 2);
}

function firstSentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "";
  const match = t.match(/^[^.!?\n]+[.!?]?/);
  return (match?.[0] ?? t).slice(0, 200);
}

function shorten(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

function buildHashtags(title: string, body: string): string[] {
  const words = `${title} ${body}`
    .toLowerCase()
    .replace(/[^a-záéíóúñü0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4 && !["para", "como", "esta", "este", "esto", "pero", "todo", "cuando", "desde", "sobre"].includes(w));
  const tags = [...new Set(words)].slice(0, 6);
  if (tags.length === 0) tags.push("marketing");
  return tags;
}

/* ── Informe semanal de rendimiento ─────────────────────────── */

export interface WeeklyReportContext {
  weekStart: string;
  weekEnd: string;
  /** Posts publicados en la semana con su engagement. */
  posts: {
    channel: ChannelId;
    text: string;
    publishedAt?: string;
    postUrl?: string;
    likes?: number;
    reposts?: number;
    comments?: number;
    clicks?: number;
  }[];
  followers: Partial<Record<ChannelId, { count: number; fetchedAt: string }>>;
  channelsEnabled: ChannelId[];
}

const REPORT_SYSTEM_PROMPT = `Eres un analista senior de métricas de redes sociales.

Recibes los datos reales de una semana de publicaciones (posts publicados, engagement por post
y seguidores por canal). Tu trabajo es escribir un informe ejecutivo en markdown en español.

El informe debe incluir, en este orden:
1. **Resumen ejecutivo** (3-5 líneas: qué funcionó, qué no, una cifra clave).
2. **Rendimiento por canal** (tabla: canal, posts, seguidores, likes totales, reposts, comentarios, clics; y 1-2 frases de lectura por canal).
3. **Mejor contenido de la semana** (el post con mejor engagement, por qué funcionó y qué patrón se puede repetir).
4. **Insights y aprendizajes** (3-4 conclusiones accionables basadas SOLO en los datos recibidos).
5. **Calendario sugerido para la próxima semana** (3-5 ideas de contenido basadas en lo que mejor funcionó, indicando canal y día aproximado).

Reglas: no inventes métricas que no estén en los datos; si un canal no tiene datos, dilo;
usa números exactos de la tabla; tono directo y útil, sin relleno. Responde solo con el informe en markdown.`;

/** Genera el informe semanal: con LLM si está configurado, con plantilla si no. */
export async function generateWeeklyReport(
  config: AgentConfig,
  ctx: WeeklyReportContext,
): Promise<{ report: string; usedLlm: boolean }> {
  if (config.llm.enabled) {
    try {
      const opts: LlmOptions = {
        baseUrl: config.llm.baseUrl,
        apiKey: config.llm.apiKey ?? "",
        model: config.llm.model,
        temperature: 0.6,
      };
      const raw = await chat(opts, [
        { role: "system", content: REPORT_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(ctx, null, 2) },
      ]);
      return { report: raw.trim(), usedLlm: true };
    } catch (err) {
      console.warn(`  ⚠️  LLM falló en el informe (${err instanceof Error ? err.message : err}). Usando plantilla.`);
    }
  }
  return { report: templateWeeklyReport(ctx), usedLlm: false };
}

/** Plantilla de respaldo: informe estructurado con los datos reales. */
function templateWeeklyReport(ctx: WeeklyReportContext): string {
  const totalLikes = sum(ctx.posts, (p) => p.likes);
  const totalReposts = sum(ctx.posts, (p) => p.reposts);
  const totalComments = sum(ctx.posts, (p) => p.comments);
  const totalClicks = sum(ctx.posts, (p) => p.clicks);

  const best = [...ctx.posts]
    .filter((p) => (p.likes ?? 0) + (p.reposts ?? 0) + (p.comments ?? 0) > 0)
    .sort((a, b) => (b.likes ?? 0) + (b.reposts ?? 0) + (b.comments ?? 0) - ((a.likes ?? 0) + (a.reposts ?? 0) + (a.comments ?? 0)))[0];

  const rows = ctx.channelsEnabled
    .map((c) => {
      const posts = ctx.posts.filter((p) => p.channel === c);
      const f = ctx.followers[c];
      const likes = sum(posts, (p) => p.likes);
      const reposts = sum(posts, (p) => p.reposts);
      const comments = sum(posts, (p) => p.comments);
      const clicks = sum(posts, (p) => p.clicks);
      return `| ${c} | ${posts.length} | ${f ? f.count : "—"} | ${likes || "—"} | ${reposts || "—"} | ${comments || "—"} | ${clicks || "—"} |`;
    })
    .join("\n");

  return `# 📊 Informe semanal de redes sociales

**Semana:** ${ctx.weekStart} → ${ctx.weekEnd}

## Resumen ejecutivo

Se publicaron **${ctx.posts.length} posts** en ${ctx.channelsEnabled.length} canal(es).
Engagement total de la semana: **${totalLikes} likes**, **${totalReposts} reposts**,
**${totalComments} comentarios**${totalClicks ? ` y **${totalClicks} clics**` : ""}.

## Mejor contenido de la semana

${best
  ? `El post con mejor engagement fue **${shorten(best.text, 80)}** (${best.channel}):
**${best.likes ?? 0} likes, ${best.reposts ?? 0} reposts, ${best.comments ?? 0} comentarios**.`
  : "_Sin datos de engagement esta semana._"}

## Rendimiento por canal

| Canal | Posts | Seguidores | Likes | Reposts | Coment. | Clics |
|---|---|---|---|---|---|---|
${rows}

> Los canales sin API accesible (X, LinkedIn, Instagram, Facebook, TikTok) muestran
> los datos que introduzcas manualmente en data/metrics-manual.json.

## Insights

- Revisa el patrón del contenido con mejor engagement para repetirlo la próxima semana.
- Compara el rendimiento de cada canal frente a la semana anterior para detectar tendencias.

## Calendario sugerido

Publica de forma constante usando los horarios óptimos (ver comando \`calendar\`);
reutiliza los temas que mejor engagement generaron.

_Generado automáticamente por Social Agent._`;
}

function sum(arr: { likes?: number; reposts?: number; comments?: number; clicks?: number }[], pick: (p: { likes?: number; reposts?: number; comments?: number; clicks?: number }) => number | undefined): number {
  return arr.reduce((acc, p) => acc + (pick(p) ?? 0), 0);
}

/* ── Plan editorial semanal (calendario de contenido) ───────── */

export interface EditorialPlanContext {
  weekStart: string;
  weekEnd: string;
  /** Ideas base disponibles en el store. */
  items: { title: string; kind: string }[];
  channelsEnabled: ChannelId[];
}

const PLAN_SYSTEM_PROMPT = `Eres un estratega de contenido y editor jefe de redes sociales.

Recibes las ideas base disponibles y los canales habilitados. Tu trabajo: escribir un
PLAN EDITORIAL SEMANAL en markdown en español que dé respuesta a la pregunta
"¿qué publicamos esta semana y por qué?".

El plan debe incluir:
1. **Pilares de contenido** (3-4 temas recurrentes: educar, inspirar, vender, comunidad) con ejemplos concretos.
2. **Calendario día a día** (lunes a domingo): 5-7 publicaciones, cada una con día, canal sugerido,
   gancho de la primera línea (aplicando copywriting: cifra, pregunta, afirmación audaz o curiosidad)
   y objetivo (informar/inspirar/vender/conversación). Usa los horarios óptimos por plataforma.
3. **Variantes A/B** para la publicación principal de la semana: 3 ganchos alternativos listos para publicar.
4. **Ritmo y equilibrio**: mezcla tipos de contenido, no repitas canal el mismo día, deja espacio entre publicaciones.

Reglas: basa TODO en las ideas recibidas (si faltan ideas, propón las tuyas y márcalo);
no inventes fechas fuera de la semana indicada; tono directo, accionable, sin relleno.`;

/** Genera el plan editorial semanal: con LLM si está configurado, con plantilla si no. */
export async function generateEditorialPlan(
  config: AgentConfig,
  ctx: EditorialPlanContext,
): Promise<{ plan: string; usedLlm: boolean }> {
  if (config.llm.enabled) {
    try {
      const opts: LlmOptions = {
        baseUrl: config.llm.baseUrl,
        apiKey: config.llm.apiKey ?? "",
        model: config.llm.model,
        temperature: 0.7,
      };
      const raw = await chat(opts, [
        { role: "system", content: PLAN_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(ctx, null, 2) },
      ]);
      return { plan: raw.trim(), usedLlm: true };
    } catch (err) {
      console.warn(`  ⚠️  LLM falló en el plan (${err instanceof Error ? err.message : err}). Usando plantilla.`);
    }
  }
  return { plan: templateEditorialPlan(ctx), usedLlm: false };
}

/** Plantilla de respaldo: pilares + calendario día a día con horarios óptimos. */
function templateEditorialPlan(ctx: EditorialPlanContext): string {
  const days = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
  const slots = ["09:00", "11:00", "13:00", "17:00", "19:00"];
  const topics = ctx.items.map((i) => i.title);
  const pool = topics.length >= 5 ? topics : [...topics, ...topics, ...topics];

  const calendar = days
    .map((day, i) => {
      const channel = ctx.channelsEnabled[i % Math.max(ctx.channelsEnabled.length, 1)] ?? "mastodon";
      const topic = pool[i] ?? "Tema libre (propuesta del agente)";
      const goal = ["informar", "inspirar", "generar conversación", "vender"][i % 4];
      return `- **${day}** ${slots[i % slots.length]} · ${channel} · «${topic}» → objetivo: ${goal}`;
    })
    .slice(0, 5)
    .join("\n");

  return `# 🗓️ Plan editorial ${ctx.weekStart} → ${ctx.weekEnd}

## Pilares de contenido
${topics.slice(0, 4).map((t, i) => `- **Pilar ${i + 1}**: ${t}`).join("\n") || "- _Aún no hay ideas base: ejecuta `ingest` con contenido en content/ideas._"}

## Calendario día a día
${calendar}

## Variante A/B (publicación principal)
- **A** — pregunta: «¿Sabías esto sobre ${topics[0] ?? "tu nicho"}?»
- **B** — cifra: «3 datos de ${topics[0] ?? "tu nicho"} que cambian tu enfoque»
- **C** — afirmación: «Nadie te dice esto de ${topics[0] ?? "tu nicho"}»

## Ritmo y equilibrio
- Mezcla educar/inspirar/vender; no repitas canal el mismo día.
- Respeta el intervalo mínimo entre publicaciones (ver .env).

_Generado automáticamente por Social Agent (plantilla: activa LLM_API_KEY para un plan experto)._`;
}

export { CHANNELS };
