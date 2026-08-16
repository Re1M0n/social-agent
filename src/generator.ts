import { generateWithLlm, generateWithTemplates } from "./agent/marketingAgent.js";
import { enabledChannels } from "./channels/index.js";
import type { AgentConfig } from "./config.js";
import type { Store } from "./storage.js";
import type { ChannelId, Draft } from "./types.js";

/** Genera drafts para los ítems de contenido que aún no tienen posts en un canal. */
export async function generateForAll(
  config: AgentConfig,
  store: Store,
): Promise<{ generated: number; itemsProcessed: number }> {
  const channels = enabledChannels(config.channels);
  if (channels.length === 0) {
    return { generated: 0, itemsProcessed: 0 };
  }

  let generated = 0;
  let itemsProcessed = 0;

  for (const item of store.contentItems) {
    const covered = store.channelsCovered(item.id);
    const missing = channels.filter((c) => !covered.has(c)) as ChannelId[];
    if (missing.length === 0) continue;

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

    const added = store.addDrafts(drafts);
    generated += added;
    if (added > 0) itemsProcessed++;
  }

  return { generated, itemsProcessed };
}
