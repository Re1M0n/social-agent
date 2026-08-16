import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextSlot } from "../scheduler.js";

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
});
