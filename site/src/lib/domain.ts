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
  };
}

export function mutateItem(
  item: Item,
  memberId: string,
  changes: Partial<Pick<Item, "name" | "status" | "deletedAt">>,
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

