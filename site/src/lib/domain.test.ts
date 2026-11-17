import { describe, expect, it } from "vitest";
import { addEan, createItem, findItemByEan, hasValidCheckDigit, isIncomingNewer, mergeItems, mutateItem, normalizeEan, normalizeItemName } from "./domain";
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

  it("godtar strekkoder serveren har slått sammen uten ny mutasjon", () => {
    const current = { ...base, syncSeq: 4 };
    expect(isIncomingNewer({ ...current, syncSeq: 5, eans: ["7038010009457"] }, current)).toBe(true);
    expect(isIncomingNewer({ ...current }, current)).toBe(false);
  });

  it("beholder slettemarkører ved sammenslåing", () => {
    const deleted = { ...base, deletedAt: "2026-11-14T11:00:00.000Z", changedAt: "2026-11-14T11:00:00.000Z" };
    expect(mergeItems([base], [deleted])[0].deletedAt).not.toBeNull();
  });
});


describe("hasValidCheckDigit", () => {
  it("godtar gyldige EAN-13, EAN-8 og UPC-A gjort om til EAN-13", () => {
    expect(hasValidCheckDigit("4006381333931")).toBe(true);
    expect(hasValidCheckDigit("96385074")).toBe(true);
    expect(hasValidCheckDigit("0036000291452")).toBe(true);
  });

  it("avviser feil kontrollsiffer og feil lengde", () => {
    expect(hasValidCheckDigit("4006381333932")).toBe(false);
    expect(hasValidCheckDigit("1234567")).toBe(false);
  });
});

describe("normalizeEan", () => {
  it("godtar EAN-8, EAN-13 og GTIN-14", () => {
    expect(normalizeEan("70380100")).toBe("70380100");
    expect(normalizeEan("7038010000065")).toBe("7038010000065");
    expect(normalizeEan("17038010000062")).toBe("17038010000062");
  });

  it("gjør UPC-A om til EAN-13", () => {
    expect(normalizeEan("036000291452")).toBe("0036000291452");
  });

  it("fjerner mellomrom", () => {
    expect(normalizeEan(" 7038010 000065 ")).toBe("7038010000065");
  });

  it("avviser feil lengde og andre tegn", () => {
    expect(normalizeEan("")).toBeNull();
    expect(normalizeEan("1234567")).toBeNull();
    expect(normalizeEan("123456789")).toBeNull();
    expect(normalizeEan("703801000006X")).toBeNull();
    expect(normalizeEan("703-8010000065")).toBeNull();
  });
});

describe("strekkoder på varer", () => {
  const withEan: Item = { ...base, eans: ["7038010000065"] };

  it("finner varen med strekkoden", () => {
    expect(findItemByEan([{ ...base, id: "item-2" }, withEan], "7038010000065")?.id).toBe("item-1");
  });

  it("hopper over slettede varer og gamle varer uten eans", () => {
    expect(findItemByEan([base, { ...withEan, deletedAt: "2026-11-14T11:00:00.000Z" }], "7038010000065")).toBeUndefined();
  });

  it("legger til en strekkode uten duplikater", () => {
    expect(addEan(base, "7038010000065")).toEqual(["7038010000065"]);
    expect(addEan(withEan, "7038010000065")).toEqual(["7038010000065"]);
    expect(addEan(withEan, "70380100")).toEqual(["7038010000065", "70380100"]);
  });

  it("tar med strekkoder når en vare opprettes og endres", () => {
    expect(createItem("home-1", "member-1", "Melk").eans).toEqual([]);
    expect(createItem("home-1", "member-1", "Melk", "empty", ["7038010000065"]).eans).toEqual(["7038010000065"]);
    const { item, mutation } = mutateItem(base, "member-2", { eans: addEan(base, "70380100") });
    expect(item.eans).toEqual(["70380100"]);
    expect(mutation.item.eans).toEqual(["70380100"]);
  });
});
