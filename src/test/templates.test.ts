import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateEditorialPlan, generateWithTemplates } from "../agent/marketingAgent.js";
import type { ContentItem } from "../types.js";
import { testConfig } from "./helpers.js";

const idea: ContentItem = {
  id: "idea-1",
  kind: "idea",
  title: "Lanzamos una app de productividad",
  body: "Planifica tu día en 60 segundos con IA.",
  mediaType: "text",
  ingestedAt: "2026-08-10T10:00:00Z",
};

describe("generateWithTemplates", () => {
  it("genera un draft por canal", () => {
    const drafts = generateWithTemplates(idea, ["mastodon", "bluesky", "twitter"]);
    assert.equal(drafts.length, 3);
    assert.deepEqual(
      drafts.map((d) => d.channel).sort(),
      ["bluesky", "mastodon", "twitter"],
    );
  });

  it("respeta el límite de 280 caracteres en twitter", () => {
    const [draft] = generateWithTemplates(idea, ["twitter"]);
    assert.ok(draft.text.length <= 280, `longitud ${draft.text.length}`);
  });

  it("no filtra metadatos internos de archivos media", () => {
    const mediaItem: ContentItem = {
      id: "media-1",
      kind: "media",
      title: "Demo del producto",
      body: "Archivo: media/demo.mp4\nTamaño: 12.0 MB",
      filePath: "/tmp/demo.mp4",
      mediaType: "video",
      ingestedAt: "2026-08-10T10:00:00Z",
    };
    const [draft] = generateWithTemplates(mediaItem, ["mastodon"]);
    assert.ok(!draft.text.includes("/tmp/"), `filtra ruta: ${draft.text}`);
    assert.ok(!draft.text.includes("12.0 MB"), `filtra tamaño: ${draft.text}`);
    assert.ok(draft.mediaPaths?.includes("/tmp/demo.mp4"));
  });

  it("asigna ids deterministas y únicos por ítem+canal", () => {
    const drafts = generateWithTemplates(idea, ["mastodon", "bluesky"]);
    assert.equal(new Set(drafts.map((d) => d.id)).size, 2);
  });

  it("incluye variantes A/B de gancho listas para publicar", () => {
    const [draft] = generateWithTemplates(idea, ["twitter"]);
    assert.ok(draft.variants && draft.variants.length >= 2, "hay al menos 2 variantes");
    for (const v of draft.variants ?? []) {
      assert.ok(v.length > 0, "variante no vacía");
      assert.ok(v.length <= 280, `variante dentro del límite: ${v.length}`);
      assert.notEqual(v, draft.text, "variante distinta de la principal");
    }
  });
});

describe("generateEditorialPlan (plantilla)", () => {
  it("genera un plan semanal con pilares, calendario y variantes A/B", async () => {
    // Hermético: sin .env local; llm ya desactivado en el config de test.
    const config = testConfig();
    const { plan, usedLlm } = await generateEditorialPlan(config, {
      weekStart: "2026-08-10",
      weekEnd: "2026-08-16",
      items: [
        { title: "Lanzamiento de app de productividad", kind: "idea" },
        { title: "Cómo empezar en LinkedIn", kind: "idea" },
        { title: "Retrospectiva de la semana", kind: "idea" },
      ],
      channelsEnabled: ["mastodon", "bluesky", "linkedin"],
    });
    assert.equal(usedLlm, false);
    for (const section of ["Pilares de contenido", "Calendario día a día", "Variante A/B"]) {
      assert.ok(plan.includes(section), `falta sección: ${section}`);
    }
    assert.match(plan, /Lunes/);
  });
});
