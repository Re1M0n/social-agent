import type { AgentConfig } from "../config.js";
import { CHANNELS, type ChannelConfig, type ChannelId } from "../types.js";

/**
 * Config de test 100% hermética: NO lee el .env local ni variables de entorno.
 *
 * Todos los valores quedan fijados explícitamente, así el resultado de los tests
 * no depende de la máquina donde corran (desarrollo local, CI, GitHub Actions).
 * Un fallo como el del panel (que pasaba en local con .env y fallaba en CI sin él)
 * no puede repetirse si los tests usan esta factory en vez de loadConfig().
 */
export function testConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const channels = {} as Record<ChannelId, ChannelConfig>;
  for (const id of CHANNELS) {
    channels[id] = { enabled: false, credentials: {}, options: {} };
  }

  const config: AgentConfig = {
    root: process.cwd(),
    contentDir: "content",
    ideasDir: "content/ideas",
    mediaDir: "content/media",
    dataFile: "data/agent.json",
    autoPublish: false,
    dryRun: true,
    minIntervalMs: 60 * 60 * 1000,
    llm: {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: undefined,
      model: "gpt-4o-mini",
      enabled: false,
      // Tests herméticos: nunca sondear la red en busca de IA local.
      localLlm: "off",
      speed: "equilibrado",
    },
    channels,
    ...overrides,
  };
  return config;
}

/** Habilita un canal en un config de test (opcionalmente con credenciales). */
export function enableChannel(
  config: AgentConfig,
  id: ChannelId,
  credentials: Record<string, string | undefined> = {},
): AgentConfig {
  config.channels[id] = { enabled: true, credentials, options: {} };
  return config;
}
