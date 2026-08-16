import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../config.js";

/**
 * Hermético: los tests de configuración no leen el .env del repo (se usa un
 * directorio temporal sin .env) y controlan explícitamente las variables LLM.
 */
const LLM_ENV_KEYS = [
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_PROVIDER",
  "LLM_ENABLED",
  "LLM_FREE_FALLBACK",
];

describe("config: comunicación con la IA", () => {
  let root = "";
  const saved = new Map<string, string | undefined>();

  before(() => {
    root = mkdtempSync(join(tmpdir(), "social-agent-config-"));
    for (const k of LLM_ENV_KEYS) saved.set(k, process.env[k]);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function withLlmEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    for (const k of LLM_ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  }

  it("sin LLM_API_KEY usa el proveedor gratuito anónimo (Kilo) por defecto", () => {
    withLlmEnv({}, () => {
      const config = loadConfig(root);
      assert.equal(config.llm.enabled, true, "la IA debe estar activa sin clave");
      assert.equal(config.llm.provider, "kilo-anon");
      assert.equal(config.llm.baseUrl, "https://api.kilo.ai/api/gateway");
      assert.equal(config.llm.model, "openrouter/free");
      assert.equal(config.llm.apiKey, undefined);
    });
  });

  it("LLM_FREE_FALLBACK=0 desactiva la IA sin clave (plantillas)", () => {
    withLlmEnv({ LLM_FREE_FALLBACK: "0" }, () => {
      const config = loadConfig(root);
      assert.equal(config.llm.enabled, false);
    });
  });

  it("con LLM_API_KEY usa el proveedor configurado", () => {
    withLlmEnv(
      { LLM_API_KEY: "sk-test", LLM_BASE_URL: "https://ejemplo.test/v1", LLM_MODEL: "modelo-test", LLM_PROVIDER: "groq" },
      () => {
        const config = loadConfig(root);
        assert.equal(config.llm.enabled, true);
        assert.equal(config.llm.provider, "groq");
        assert.equal(config.llm.baseUrl, "https://ejemplo.test/v1");
        assert.equal(config.llm.model, "modelo-test");
        assert.equal(config.llm.apiKey, "sk-test");
      },
    );
  });

  it("LLM_ENABLED=0 fuerza plantillas aunque haya clave", () => {
    withLlmEnv({ LLM_API_KEY: "sk-test", LLM_ENABLED: "0" }, () => {
      assert.equal(loadConfig(root).llm.enabled, false);
    });
  });
});
