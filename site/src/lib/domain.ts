import type { Item, ItemMutation, ItemStatus } from "../types";

export function normalizeItemName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("nb-NO");
}

export function cleanDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 60);
}

export function createItem(
  homeId: string,
  memberId: string,
  name: string,
  status: ItemStatus = "empty",
  eans: string[] = [],
): Item {
  const now = new Date().toISOString();
  const mutationId = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    homeId,
    name: cleanDisplayName(name),
    normalizedName: normalizeItemName(name),
    status,
    changedAt: now,
    changedBy: memberId,
    mutationId,
    deletedAt: null,
    eans,
  };
}

export function mutateItem(
  item: Item,
  memberId: string,
  changes: Partial<Pick<Item, "name" | "status" | "deletedAt" | "eans">>,
): { item: Item; mutation: ItemMutation } {
  const changedAt = new Date().toISOString();
  const mutationId = crypto.randomUUID();
  const next: Item = {
    ...item,
    ...changes,
    normalizedName: changes.name ? normalizeItemName(changes.name) : item.normalizedName,
    changedAt,
    changedBy: memberId,
    mutationId,
  };
  return {
    item: next,
    mutation: {
      id: mutationId,
      itemId: next.id,
      operation: next.deletedAt ? "delete" : "upsert",
      changedAt,
      item: next,
    },
  };
}

/** Digits only. UPC-A (12) becomes EAN-13 with a leading zero. */
export function normalizeEan(raw: string): string | null {
  const digits = raw.replace(/\s/g, "");
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 12) return `0${digits}`;
  return digits.length === 8 || digits.length === 13 || digits.length === 14 ? digits : null;
}

/** GS1 check digit for EAN-8, EAN-13 and GTIN-14. UPC-E fails this and needs a second read. */
export function hasValidCheckDigit(ean: string): boolean {
  if (!/^\d{8,14}$/.test(ean)) return false;
  const digits = [...ean].map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function findItemByEan(items: Item[], ean: string): Item | undefined {
  return items.find((item) => !item.deletedAt && (item.eans ?? []).includes(ean));
}

export function addEan(item: Item, ean: string): string[] {
  const eans = item.eans ?? [];
  return eans.includes(ean) ? eans : [...eans, ean];
}

export function itemToMutation(item: Item): ItemMutation {
  return {
    id: item.mutationId,
    itemId: item.id,
    operation: item.deletedAt ? "delete" : "upsert",
    changedAt: item.changedAt,
    item,
  };
}

export function isIncomingNewer(incoming: Item, current?: Item): boolean {
  if (!current) return true;
  if (incoming.changedAt !== current.changedAt) return incoming.changedAt > current.changedAt;
  // The server can merge barcodes into a row without a new mutation; a higher syncSeq carries them.
  if (incoming.mutationId === current.mutationId) return (incoming.syncSeq ?? 0) > (current.syncSeq ?? 0);
  return incoming.mutationId > current.mutationId;
}

export function mergeItems(current: Item[], incoming: Item[]): Item[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    if (isIncomingNewer(item, byId.get(item.id))) byId.set(item.id, item);
  }
  return [...byId.values()];
}

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "nå";
  if (diff < 3_600_000) return `for ${Math.floor(diff / 60_000)} min siden`;
  if (diff < 86_400_000) return `for ${Math.floor(diff / 3_600_000)} t siden`;
  return new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "short" }).format(new Date(iso));
}

