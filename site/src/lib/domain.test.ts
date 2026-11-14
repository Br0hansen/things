import { describe, expect, it } from "vitest";
import { isIncomingNewer, mergeItems, normalizeItemName } from "./domain";
import type { Item } from "../types";

const base: Item = {
  id: "item-1",
  homeId: "home-1",
  name: "Melk",
  normalizedName: "melk",
  status: "empty",
  changedAt: "2026-11-14T10:00:00.000Z",
  changedBy: "member-1",
  mutationId: "00000000-0000-0000-0000-000000000001",
  deletedAt: null,
};

describe("normalizeItemName", () => {
  it("normaliserer mellomrom og store bokstaver", () => {
    expect(normalizeItemName("  ToiletT  PAPIR ")).toBe("toilett papir");
  });
});

describe("last-write-wins", () => {
  it("avviser en eldre endring", () => {
    expect(isIncomingNewer({ ...base, changedAt: "2026-11-14T09:59:00.000Z" }, base)).toBe(false);
  });

  it("bruker mutasjons-ID som deterministisk tie-breaker", () => {
    expect(isIncomingNewer({ ...base, mutationId: "00000000-0000-0000-0000-000000000002" }, base)).toBe(true);
  });

  it("beholder slettemarkører ved sammenslåing", () => {
    const deleted = { ...base, deletedAt: "2026-11-14T11:00:00.000Z", changedAt: "2026-11-14T11:00:00.000Z" };
    expect(mergeItems([base], [deleted])[0].deletedAt).not.toBeNull();
  });
});

