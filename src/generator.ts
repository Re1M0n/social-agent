import { generateWithLlm, generateWithTemplates } from "./agent/marketingAgent.js";
import { enabledChannels } from "./channels/index.js";
import type { AgentConfig } from "./config.js";
import type { Store } from "./storage.js";
import type { ChannelId, ContentItem, Draft } from "./types.js";

/** Progreso en vivo de una generación (para el panel: polling a /api/generation). */
export interface GenerationProgress {
  /** Título del ítem que se está procesando (undefined al terminar). */
  currentItem?: string;
  /** Índice del ítem actual (1-based). */
  index: number;
  /** Total de ítems a procesar. */
  total: number;
  /** Drafts acumulados hasta ahora. */
  generated: number;
}

/** Genera drafts para los ítems de contenido que aún no tienen posts en un canal. */
export async function generateForAll(
  config: AgentConfig,
  store: Store,
  onProgress?: (p: GenerationProgress) => void,
): Promise<{ generated: number; itemsProcessed: number }> {
  const items = store.contentItems;
  let generated = 0;
  let itemsProcessed = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    onProgress?.({ currentItem: item.title, index: i + 1, total: items.length, generated });
    const { drafts, added } = await generateItem(config, store, item);
    generated += added;
    if (added > 0) itemsProcessed++;
  }

  onProgress?.({ currentItem: undefined, index: items.length, total: items.length, generated });
  return { generated, itemsProcessed };
}

/** Regenera un ítem concreto (para el panel: botón "generar" por ítem). */
export async function generateForItem(
  config: AgentConfig,
  store: Store,
  itemId: string,
  onProgress?: (p: GenerationProgress) => void,
): Promise<{ generated: number }> {
  const item = store.getContentItem(itemId);
  if (!item) return { generated: 0 };
  onProgress?.({ currentItem: item.title, index: 1, total: 1, generated: 0 });
  const { added } = await generateItem(config, store, item);
  onProgress?.({ currentItem: undefined, index: 1, total: 1, generated: added });
  return { generated: added };
}

/** Genera los drafts que falten para un ítem (solo canales habilitados sin cubrir). */
async function generateItem(
  config: AgentConfig,
  store: Store,
  item: ContentItem,
): Promise<{ drafts: Draft[]; added: number }> {
  const channels = enabledChannels(config.channels);
  if (channels.length === 0) return { drafts: [], added: 0 };

  const covered = store.channelsCovered(item.id);
  const missing = channels.filter((c) => !covered.has(c)) as ChannelId[];
  if (missing.length === 0) return { drafts: [], added: 0 };

  let drafts: Draft[];
  if (config.llm.enabled) {
    try {
      drafts = await generateWithLlm(config, item, missing);
    } catch (err) {
      console.warn(
        `  ⚠️  LLM falló para "${item.title}" (${err instanceof Error ? err.message : err}). Usando plantillas.`,
      );
      drafts = generateWithTemplates(item, missing);
    }
  } else {
    drafts = generateWithTemplates(item, missing);
  }

  return { drafts, added: store.addDrafts(drafts) };
}
