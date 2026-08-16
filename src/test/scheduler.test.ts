import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BEST_SLOTS,
  buildLearnablePosts,
  engagementScore,
  learnSchedule,
  loadLearnedSchedule,
  nextSlot,
  saveLearnedSchedule,
  scheduleFor,
  type LearnablePost,
} from "../scheduler.js";

/** Genera posts con la hora LOCAL deseada (independiente de la zona horaria de la máquina). */
function makePosts(
  channel: string,
  days: number[],
  hour: number,
  engagement: { likes?: number; reposts?: number; comments?: number } = { likes: 10 },
): LearnablePost[] {
  return days.map((day) => ({
    channel: channel as never,
    // new Date(año, mes, día, hora) construye en hora local: el getHours()
    // del scheduler verá exactamente `hour` en cualquier zona horaria.
    publishedAt: new Date(2026, 7, day, hour, 0, 0).toISOString(),
    engagement,
  }));
}

describe("scheduler", () => {
  it("respeta el intervalo mínimo entre publicaciones", () => {
    const after = new Date("2026-08-10T10:00:00Z"); // lunes
    const slot = nextSlot("mastodon", after, 60 * 60 * 1000);
    assert.ok(slot.getTime() >= after.getTime() + 60 * 60 * 1000);
  });

  it("elige una franja horaria recomendada del canal", () => {
    const after = new Date("2026-08-10T00:00:00Z"); // lunes 00:00
    const slot = nextSlot("linkedin", after, 0);
    // LinkedIn recomienda martes-jueves (2,3,4) 8-11h y 17h.
    assert.ok([2, 3, 4].includes(slot.getDay()), `día inesperado: ${slot.getDay()}`);
    assert.ok([8, 9, 10, 11, 17].includes(slot.getHours()), `hora inesperada: ${slot.getHours()}`);
  });

  it("espacia publicaciones consecutivas del mismo canal", () => {
    const after = new Date("2026-08-10T08:00:00Z");
    const a = nextSlot("twitter", after, 60 * 60 * 1000);
    const b = nextSlot("twitter", new Date(a.getTime() + 60 * 60 * 1000), 60 * 60 * 1000);
    assert.ok(b.getTime() > a.getTime());
  });

  it("fallback: respeta el intervalo aunque no haya franja válida", () => {
    const after = new Date("2026-08-10T23:59:00Z");
    const slot = nextSlot("tiktok", after, 30 * 60 * 1000);
    assert.ok(slot.getTime() >= after.getTime() + 30 * 60 * 1000);
  });

  describe("engagementScore", () => {
    it("pondera comentarios y reposts por encima de likes", () => {
      assert.equal(engagementScore({ likes: 1, reposts: 2, comments: 3, clicks: 1 }), 1 + 4 + 9 + 1);
      assert.equal(engagementScore({}), 0);
    });
  });

  describe("learnSchedule", () => {
    it("no devuelve nada para canales sin datos", () => {
      const learned = learnSchedule([]);
      assert.deepEqual(learned, {});
    });

    it("aprende las horas con más engagement real de un canal", () => {
      // 12 posts publicados a las 20h (que NO está en el estático de bluesky: 9-11,15-16).
      const posts = makePosts("bluesky", [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], 20, {
        likes: 30,
        reposts: 5,
        comments: 3,
      });
      const learned = learnSchedule(posts);
      const b = learned.bluesky;
      assert.ok(b, "debería haber aprendido bluesky");
      assert.equal(b.samples, 12);
      assert.ok(b.hours.includes(20), `la hora con engagement (20) debería estar aprendida: ${b.hours}`);
      assert.ok(!b.hours.includes(16), "la hora muerta (16) no debería estar: " + b.hours);
    });

    it("mezcla el prior estático cuando hay pocas muestras", () => {
      // 3 posts en 20h: poco peso, el prior (9-11,15-16) debe seguir dominando.
      const posts = makePosts("bluesky", [10, 11, 12], 20, { likes: 30 });
      const learned = learnSchedule(posts);
      const b = learned.bluesky!;
      assert.ok(b.hours.includes(20), "20h aprendida (poco peso pero presente)");
      // Con w = 3/10 = 0.3, las horas estáticas puntúan 0.7 y la 20h puntúa 0.3·(90/1).
      // El ranking mantiene el prior por delante; 20h entra solo si cabe en las 6 mejores.
      assert.ok(b.days.some((d) => BEST_SLOTS.bluesky.days.includes(d)), "el prior sigue presente");
    });

    it("aprende por canal de forma independiente", () => {
      const posts = [
        ...makePosts("mastodon", [10, 11, 12], 8, { likes: 5 }),
        ...makePosts("tiktok", [10, 11, 12], 22, { likes: 50 }),
      ];
      const learned = learnSchedule(posts);
      assert.ok(learned.mastodon?.hours.includes(8), "mastodon aprende la mañana");
      assert.ok(learned.tiktok?.hours.includes(22), "tiktok aprende la noche");
      assert.equal(learned.mastodon!.samples, 3);
      assert.equal(learned.tiktok!.samples, 3);
    });
  });

  describe("scheduleFor / nextSlot con modelo aprendido", () => {
    it("usa el modelo aprendido cuando existe", () => {
      const learned = { bluesky: { days: [1, 2, 3, 4, 5], hours: [20], samples: 12, avgEngagement: 40 } };
      const after = new Date("2026-08-10T10:00:00Z"); // lunes
      const slot = nextSlot("bluesky", after, 0, 3, learned);
      assert.equal(slot.getHours(), 20, "debería usar la hora aprendida");
    });

    it("cae al prior estático sin modelo aprendido", () => {
      const after = new Date("2026-08-10T00:00:00Z"); // lunes
      const slot = nextSlot("linkedin", after, 0);
      assert.ok([8, 9, 10, 11, 17].includes(slot.getHours()));
    });

    it("scheduleFor devuelve estático si el canal no está aprendido", () => {
      const s = scheduleFor("twitter", { bluesky: { days: [1], hours: [20], samples: 5, avgEngagement: 10 } });
      assert.deepEqual(s, BEST_SLOTS.twitter);
    });
  });

  describe("persistencia y buildLearnablePosts", () => {
    it("guarda y carga el modelo aprendido", () => {
      const dir = mkdtempSync(join(tmpdir(), "sched-"));
      const file = join(dir, "schedule-learned.json");
      const model = { tiktok: { days: [0, 1, 2], hours: [22], samples: 9, avgEngagement: 55 } };
      saveLearnedSchedule(file, model);
      assert.deepEqual(loadLearnedSchedule(file), model);
      rmSync(dir, { recursive: true, force: true });
    });

    it("carga vacío si el archivo no existe o está corrupto", () => {
      const dir = mkdtempSync(join(tmpdir(), "sched-"));
      const file = join(dir, "nope.json");
      assert.deepEqual(loadLearnedSchedule(file), {});
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "no-json{");
      assert.deepEqual(loadLearnedSchedule(bad), {});
      rmSync(dir, { recursive: true, force: true });
    });

    it("buildLearnablePosts empareja posts publicados con su métrica", () => {
      const published = [
        { channel: "mastodon" as const, publishedAt: "2026-08-10T08:00:00Z", id: "p1" },
        { channel: "bluesky" as const, publishedAt: "2026-08-10T09:00:00Z", id: "p2" },
        { channel: "mastodon" as const, publishedAt: undefined, id: "p3" }, // sin fecha: se excluye
        { channel: "mastodon" as const, publishedAt: "2026-08-10T08:00:00Z", id: "p4" }, // sin métrica: se excluye
      ];
      const metrics = { posts: { p1: { engagement: { likes: 5 } }, p2: { engagement: { likes: 7 } } } };
      const result = buildLearnablePosts(published, metrics);
      assert.equal(result.length, 2);
      assert.deepEqual(result.map((r) => r.channel), ["mastodon", "bluesky"]);
      assert.equal(result[0].engagement.likes, 5);
    });
  });

  describe("nextSlot con modelo aprendido en distintas zonas horarias", () => {
    it("usa la hora aprendida aunque la máquina no esté en UTC", () => {
      const learned = { bluesky: { days: [1, 2, 3, 4, 5], hours: [20], samples: 12, avgEngagement: 40 } };
      const after = new Date(2026, 7, 10, 10, 0, 0); // lunes 10:00 local
      const slot = nextSlot("bluesky", after, 0, 3, learned);
      assert.equal(slot.getHours(), 20, "debería usar la hora aprendida");
    });
  });
});
