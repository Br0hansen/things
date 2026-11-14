import type { AppSnapshot, Identity, Member, SyncResponse } from "../types";
import { getAccessToken } from "./auth";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, "") ?? "";
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

export const isRemoteConfigured = Boolean(supabaseUrl && supabaseKey);

interface ApiOptions {
  deviceToken?: string;
}

async function callApi<T>(action: string, payload: Record<string, unknown>, options: ApiOptions = {}): Promise<T> {
  if (!isRemoteConfigured) throw new Error("Supabase er ikke konfigurert ennå.");
  const accessToken = await getAccessToken();
  const response = await fetch(`${supabaseUrl}/functions/v1/things-api`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: supabaseKey,
      authorization: `Bearer ${accessToken ?? supabaseKey}`,
      ...(options.deviceToken ? { "x-things-device-token": options.deviceToken } : {}),
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "Kunne ikke kontakte Things-tjenesten.");
  return data as T;
}

export async function createRemoteHome(displayName: string): Promise<{ identity: Identity; members: Member[] }> {
  return callApi("create_home", { displayName });
}

export async function joinRemoteHome(inviteToken: string, displayName: string): Promise<{ identity: Identity; members: Member[] }> {
  return callApi("join_invite", { inviteToken, displayName });
}

export async function syncRemote(snapshot: AppSnapshot): Promise<SyncResponse> {
  if (!snapshot.identity) throw new Error("Mangler lokal medlemstilgang.");
  return callApi(
    "sync",
    { cursor: snapshot.syncCursor, mutations: snapshot.outbox },
    { deviceToken: snapshot.identity.deviceToken },
  );
}

export async function createInvite(identity: Identity): Promise<{ token: string; expiresAt: string }> {
  return callApi("create_invite", {}, { deviceToken: identity.deviceToken });
}

export async function createTransfer(identity: Identity): Promise<{ token: string; expiresAt: string }> {
  return callApi("create_transfer", {}, { deviceToken: identity.deviceToken });
}

export async function consumeTransfer(transferToken: string): Promise<{ identity: Identity; members: Member[] }> {
  return callApi("consume_transfer", { transferToken });
}

export async function claimRemoteAccount(identity: Identity): Promise<{ identity: Identity; members: Member[] }> {
  return callApi("claim_account", {}, { deviceToken: identity.deviceToken });
}

export async function removeRemoteMember(identity: Identity, memberId: string): Promise<{ members: Member[] }> {
  return callApi("remove_member", { memberId }, { deviceToken: identity.deviceToken });
}

export async function leaveRemoteHome(identity: Identity): Promise<void> {
  await callApi("leave_home", {}, { deviceToken: identity.deviceToken });
}

export async function deleteRemoteHome(identity: Identity): Promise<void> {
  await callApi("delete_home", { confirmation: "SLETT" }, { deviceToken: identity.deviceToken });
}

