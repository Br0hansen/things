export type ItemStatus = "have" | "soon" | "empty";
export type MemberRole = "owner" | "member";

export interface Member {
  id: string;
  homeId: string;
  displayName: string;
  role?: MemberRole;
  accountLinked?: boolean;
}

export interface Item {
  id: string;
  homeId: string;
  name: string;
  normalizedName: string;
  status: ItemStatus;
  changedAt: string;
  changedBy: string;
  mutationId: string;
  deletedAt: string | null;
  /** Missing in snapshots saved before barcode scanning; treat as []. */
  eans?: string[];
  syncSeq?: number;
}

export interface Identity {
  homeId: string;
  memberId: string;
  deviceId: string;
  deviceToken: string;
  displayName: string;
  accountLinked?: boolean;
  role?: MemberRole;
}

export type MutationOperation = "upsert" | "delete";

export interface ItemMutation {
  id: string;
  itemId: string;
  operation: MutationOperation;
  changedAt: string;
  item: Item;
}

export interface AppSnapshot {
  identity: Identity | null;
  members: Member[];
  items: Item[];
  outbox: ItemMutation[];
  syncCursor: number;
}

export interface SyncResponse {
  items: Item[];
  members: Member[];
  cursor: number;
  acceptedMutationIds: string[];
}

export const EMPTY_SNAPSHOT: AppSnapshot = {
  identity: null,
  members: [],
  items: [],
  outbox: [],
  syncCursor: 0,
};

