import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("THINGS_ALLOWED_ORIGIN") ?? "*";
const MAX_MEMBERS = 6; // Keep in sync with things_join_invite in the migrations.
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function cors(origin: string | null) {
  const allowed = ALLOWED_ORIGIN === "*" || origin === ALLOWED_ORIGIN ? (origin ?? "*") : ALLOWED_ORIGIN;
  return { "access-control-allow-origin": allowed, "access-control-allow-headers": "authorization, apikey, content-type, x-things-device-token", "access-control-allow-methods": "POST, OPTIONS", vary: "origin" };
}

function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authenticate(request: Request) {
  const token = request.headers.get("x-things-device-token");
  if (!token) throw new Error("missing_device_token");
  const tokenHash = await hashToken(token);
  const { data, error } = await db.from("things_member_devices").select("id,home_id,member_id,revoked_at").eq("token_hash", tokenHash).is("revoked_at", null).maybeSingle();
  if (error || !data) throw new Error("device_invalid");
  return data as { id: string; home_id: string; member_id: string };
}

async function authenticatedUser(request: Request, required = false) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  if (!token) {
    if (required) throw new Error("auth_required");
    return null;
  }
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) {
    if (required) throw new Error("auth_required");
    return null;
  }
  return data.user;
}

function identity(result: Record<string, string>, deviceToken: string) {
  return {
    homeId: result.homeId,
    memberId: result.memberId,
    deviceId: result.deviceId,
    displayName: result.displayName,
    deviceToken,
    accountLinked: Boolean(result.userId),
    role: result.role ?? undefined,
  };
}

function mapItem(row: Record<string, unknown>) {
  return {
    id: row.id, homeId: row.home_id, name: row.name, normalizedName: row.normalized_name,
    status: row.status, changedAt: row.changed_at, changedBy: row.changed_by,
    mutationId: row.mutation_id, deletedAt: row.deleted_at, syncSeq: row.sync_seq,
    eans: row.eans ?? [],
  };
}

function mapMember(row: Record<string, unknown>) {
  return {
    id: row.id,
    homeId: row.home_id,
    displayName: row.display_name,
    role: row.role,
    accountLinked: Boolean(row.user_id),
  };
}

async function membersFor(homeId: string) {
  const { data, error } = await db.from("things_members").select("id,home_id,display_name,role,user_id").eq("home_id", homeId).is("left_at", null).order("created_at");
  if (error) throw error;
  return (data ?? []).map(mapMember);
}

async function track(eventName: string, metadata: Record<string, boolean | number | string> = {}) {
  const safe = Object.fromEntries(Object.entries(metadata).filter(([, value]) => typeof value === "boolean" || typeof value === "number" || (typeof value === "string" && value.length < 24)));
  await db.from("things_events").insert({ event_name: eventName, metadata: safe });
}

const EAN_PATTERN = /^\d{8,14}$/;

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

// Only real Kassal HTTP calls take a slot from the shared limit of 5 per minute.
async function lookupKassal(ean: string): Promise<{ from: string; body: Record<string, unknown> }> {
  const miss = { from: "miss", body: { product: null } };
  const limited = { from: "limited", body: { product: null, rateLimited: true } };
  const unavailable = { from: "unavailable", body: { product: null, unavailable: true } };
  const key = Deno.env.get("KASSAL_API_KEY") ?? "";
  if (!key) return unavailable;
  const { data: slot, error } = await db.rpc("things_take_kassal_slot");
  if (error) throw error;
  if (slot !== true) return limited;

  let response: Response;
  try {
    response = await fetch("https://kassal.app/api/v1/products/ean/" + ean, {
      headers: { authorization: "Bearer " + key, accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (cause) {
    console.error("things-api kassal", cause instanceof Error ? cause.name : "fetch_failed");
    return unavailable;
  }
  if (response.status === 404) return miss;
  if (response.status === 429) return limited;
  if (!response.ok) {
    console.error("things-api kassal", response.status);
    return unavailable;
  }

  const payload = await response.json().catch(() => null);
  const products = Array.isArray(payload?.data?.products) ? payload.data.products : payload?.data?.name ? [payload.data] : [];
  const match = products.find((candidate: { name?: unknown } | null) => cleanText(candidate?.name));
  if (!match) return miss;
  const product = {
    ean,
    name: Array.from(cleanText(match.name)).slice(0, 200).join("").trim(),
    brand: Array.from(cleanText(match.brand)).slice(0, 200).join("").trim() || null,
    source: "kassal" as const,
  };
  const { error: insertError } = await db.from("things_products").upsert(product, { onConflict: "ean", ignoreDuplicates: true });
  if (insertError) console.error("things-api products", insertError.message);
  return { from: "kassal", body: { product, from: "kassal" } };
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);
  if (ALLOWED_ORIGIN !== "*" && origin && origin !== ALLOWED_ORIGIN) return json({ error: "origin_not_allowed" }, 403, origin);

  try {
    const body = await request.json();
    const action = String(body.action ?? "");

    if (action === "create_home") {
      const deviceToken = randomToken();
      const user = await authenticatedUser(request);
      const { data, error } = user
        ? await db.rpc("things_create_authenticated_home", { p_display_name: body.displayName, p_token_hash: await hashToken(deviceToken), p_auth_user_id: user.id })
        : await db.rpc("things_create_home", { p_display_name: body.displayName, p_token_hash: await hashToken(deviceToken) });
      if (error) throw error;
      await track("home_created");
      return json({ identity: identity(data, deviceToken), members: [{ id: data.memberId, homeId: data.homeId, displayName: data.displayName }] }, 200, origin);
    }

    if (action === "join_invite") {
      const deviceToken = randomToken();
      const user = await authenticatedUser(request);
      const params = { p_token_hash: await hashToken(String(body.inviteToken ?? "")), p_display_name: body.displayName, p_device_token_hash: await hashToken(deviceToken) };
      const { data, error } = user
        ? await db.rpc("things_join_authenticated_invite", { ...params, p_auth_user_id: user.id })
        : await db.rpc("things_join_invite", params);
      if (error) throw error;
      await track("partner_joined");
      return json({ identity: identity(data, deviceToken), members: await membersFor(data.homeId) }, 200, origin);
    }

    if (action === "consume_transfer") {
      const deviceToken = randomToken();
      const { data, error } = await db.rpc("things_consume_transfer", { p_token_hash: await hashToken(String(body.transferToken ?? "")), p_device_token_hash: await hashToken(deviceToken) });
      if (error) throw error;
      return json({ identity: identity(data, deviceToken), members: await membersFor(data.homeId) }, 200, origin);
    }

    if (action === "claim_account") {
      const user = await authenticatedUser(request, true);
      const device = await authenticate(request);
      const deviceToken = request.headers.get("x-things-device-token") ?? "";
      const { data, error } = await db.rpc("things_claim_member", { p_device_id: device.id, p_auth_user_id: user!.id });
      if (error) throw error;
      return json({ identity: identity(data, deviceToken), members: await membersFor(device.home_id) }, 200, origin);
    }

    const device = await authenticate(request);

    if (action === "create_invite") {
      const { count } = await db.from("things_members").select("id", { count: "exact", head: true }).eq("home_id", device.home_id).is("left_at", null);
      if ((count ?? 0) >= MAX_MEMBERS) return json({ error: "Hjemmet er fullt." }, 409, origin);
      const token = randomToken();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const { error } = await db.from("things_invites").insert({ home_id: device.home_id, kind: "partner", token_hash: await hashToken(token), expires_at: expiresAt });
      if (error) throw error;
      return json({ token, expiresAt }, 200, origin);
    }

    if (action === "create_transfer") {
      await db.from("things_invites").update({ used_at: new Date().toISOString() }).eq("member_id", device.member_id).eq("kind", "transfer").is("used_at", null);
      const token = randomToken();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const { error } = await db.from("things_invites").insert({ home_id: device.home_id, member_id: device.member_id, kind: "transfer", token_hash: await hashToken(token), expires_at: expiresAt });
      if (error) throw error;
      return json({ token, expiresAt }, 200, origin);
    }

    if (action === "sync") {
      const mutations = Array.isArray(body.mutations) ? body.mutations.slice(0, 100) : [];
      const acceptedMutationIds: string[] = [];
      for (const mutation of mutations) {
        const { error } = await db.rpc("things_apply_item_mutation", { p_device_id: device.id, p_mutation: mutation });
        if (error) throw error;
        acceptedMutationIds.push(mutation.id);
        const eventName = mutation.operation === "delete" ? "item_deleted" : mutation.item?.status === "have" ? "shopping_checked" : "status_changed";
        await track(eventName);
      }
      const cursor = Math.max(0, Number(body.cursor) || 0);
      const { data, error } = await db.from("things_items").select("*").eq("home_id", device.home_id).gt("sync_seq", cursor).order("sync_seq").limit(500);
      if (error) throw error;
      const nextCursor = (data ?? []).reduce((max, row) => Math.max(max, Number(row.sync_seq)), cursor);
      return json({ items: (data ?? []).map(mapItem), members: await membersFor(device.home_id), cursor: nextCursor, acceptedMutationIds }, 200, origin);
    }

    if (action === "lookup_ean") {
      const ean = String(body.ean ?? "");
      if (!EAN_PATTERN.test(ean)) return json({ error: "Ugyldig strekkode." }, 400, origin);
      const { data: product, error } = await db.from("things_products").select("ean,name,brand,source").eq("ean", ean).maybeSingle();
      if (error) throw error;
      if (product) {
        await track("ean_lookup", { from: "db" });
        return json({ product, from: "db" }, 200, origin);
      }
      const result = await lookupKassal(ean);
      await track("ean_lookup", { from: result.from });
      return json(result.body, 200, origin);
    }

    if (action === "save_product") {
      const ean = String(body.ean ?? "");
      const name = cleanText(body.name);
      if (!EAN_PATTERN.test(ean)) return json({ error: "Ugyldig strekkode." }, 400, origin);
      if (name.length < 1 || name.length > 200) return json({ error: "Ugyldig produktnavn." }, 400, origin);
      const { error } = await db.from("things_products").upsert({ ean, name, brand: null, source: "manual" }, { onConflict: "ean", ignoreDuplicates: true });
      if (error) throw error;
      return json({ ok: true }, 200, origin);
    }

    if (action === "remove_member") {
      const { error } = await db.rpc("things_remove_member", { p_device_id: device.id, p_member_id: String(body.memberId ?? "") });
      if (error) throw error;
      return json({ members: await membersFor(device.home_id) }, 200, origin);
    }

    if (action === "leave_home") {
      const { error } = await db.rpc("things_leave_home", { p_device_id: device.id });
      if (error) throw error;
      return json({ ok: true }, 200, origin);
    }

    if (action === "delete_home") {
      if (body.confirmation !== "SLETT") return json({ error: "confirmation_required" }, 400, origin);
      const { error } = await db.from("things_homes").delete().eq("id", device.home_id);
      if (error) throw error;
      return json({ ok: true }, 200, origin);
    }

    return json({ error: "unknown_action" }, 400, origin);
  } catch (cause) {
    const raw = cause instanceof Error ? cause.message : String((cause as { message?: unknown })?.message ?? "unknown_error");
    const publicMessage = raw.includes("invite_invalid") ? "Invitasjonen er brukt eller utløpt." : raw.includes("transfer_invalid") ? "Overføringslenken er brukt eller utløpt." : raw.includes("home_full") ? "Hjemmet er fullt." : raw.includes("device_invalid") ? "Denne telefonen har ikke lenger tilgang." : raw.includes("auth_required") ? "Logg inn for å fortsette." : raw.includes("member_already_claimed") ? "Dette medlemskapet er allerede koblet til en annen konto." : raw.includes("already_member") ? "Denne kontoen er allerede medlem av hjemmet." : raw.includes("not_owner") ? "Bare eieren kan fjerne medlemmer." : raw.includes("cannot_remove_self") ? "Du kan ikke fjerne deg selv." : raw.includes("member_not_found") ? "Medlemmet er allerede fjernet." : "Noe gikk galt. Prøv igjen.";
    console.error("things-api", raw);
    return json({ error: publicMessage }, 400, origin);
  }
});

