import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import {
  addEan,
  cleanDisplayName,
  createItem,
  findItemByEan,
  formatRelativeTime,
  itemToMutation,
  mergeItems,
  mutateItem,
  normalizeItemName,
} from "./lib/domain";
import {
  claimRemoteAccount,
  consumeTransfer,
  createInvite,
  createRemoteHome,
  createTransfer,
  deleteRemoteHome,
  isRemoteConfigured,
  joinRemoteHome,
  leaveRemoteHome,
  lookupEan,
  removeRemoteMember,
  saveProduct,
  syncRemote,
  type ProductLookup,
} from "./lib/api";
import {
  isAuthConfigured,
  loadAuthSession,
  onAuthSessionChanged,
  sendSignInCode,
  signOut,
  verifySignInCode,
  type AuthSession,
} from "./lib/auth";
import { Scanner } from "./scanner";
import { clearSnapshot, loadSnapshot, saveSnapshot } from "./storage/indexed-db";
import { EMPTY_SNAPSHOT, type AppSnapshot, type Identity, type Item, type ItemStatus, type Member } from "./types";

type Tab = "cabinet" | "shop";
type SyncState = "ready" | "syncing" | "waiting" | "error";
/** lookup is null while the server lookup is running. */
interface ScannedCode { ean: string; lookup: { name: string; note: string; fromProduct: boolean } | null }

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const MAX_MEMBERS = 6; // Keep in sync with things-api and things_join_invite.
const PENDING_MODE_KEY = "things:pending-onboarding-mode";
const PENDING_INVITE_KEY = "things:pending-invite";

const STATUS_COPY: Record<ItemStatus, { label: string; helper: string }> = {
  have: { label: "Har", helper: "Vi har nok" },
  soon: { label: "Snart tom", helper: "Kan tas med" },
  empty: { label: "Tom", helper: "Må kjøpes" },
};
const STATUS_FILTER_KEY = "things:status-filters:";

function loadStatusFilters(homeId: string): ItemStatus[] {
  try {
    const stored = JSON.parse(localStorage.getItem(`${STATUS_FILTER_KEY}${homeId}`) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter((status): status is ItemStatus => status === "have" || status === "soon" || status === "empty");
  } catch { return []; }
}

function saveStatusFilters(homeId: string, filters: ItemStatus[]) {
  try { localStorage.setItem(`${STATUS_FILTER_KEY}${homeId}`, JSON.stringify(filters)); }
  catch { /* Filtreringen virker fortsatt i denne appøkten. */ }
}

function Icon({ name }: { name: "cabinet" | "cart" | "search" | "close" | "check" | "wifi" | "person" | "house" | "trash" | "pencil" | "barcode" }) {
  const common = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true } as const;
  if (name === "cabinet") return <svg {...common}><path d="M5 3.75h14v16.5H5zM12 3.75v16.5M9.2 11.5h.1M14.7 11.5h.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>;
  if (name === "cart") return <svg {...common}><path d="M3.5 5h2l1.8 9.2h10.8l2-6.3H6.1M9 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM17 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>;
  if (name === "search") return <svg {...common}><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="1.8" /><path d="m15.5 15.5 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>;
  if (name === "close") return <svg {...common}><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>;
  if (name === "wifi") return <svg {...common}><path d="M4 9a12 12 0 0 1 16 0M7 12a7.5 7.5 0 0 1 10 0M10 15a3 3 0 0 1 4 0M12 18h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>;
  if (name === "person") return <svg {...common}><circle cx="9" cy="8" r="3.25" stroke="currentColor" stroke-width="1.8" /><path d="M3.75 18.5c.45-3.25 2.2-5 5.25-5s4.8 1.75 5.25 5M17.5 8.5v6M14.5 11.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>;
  if (name === "house") return <svg {...common}><path d="M4 10.5 12 4l8 6.5M6.25 9v10.25h11.5V9M10 19.25v-5h4v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>;
  if (name === "trash") return <svg {...common}><path d="M4.5 7h15M9.5 7V4.75h5V7M6.5 7l.9 12.25h9.2L17.5 7M10 11v5M14 11v5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" /></svg>;
  if (name === "barcode") return <svg {...common}><path d="M3.75 8V5.75a2 2 0 0 1 2-2H8M16 3.75h2.25a2 2 0 0 1 2 2V8M20.25 16v2.25a2 2 0 0 1-2 2H16M8 20.25H5.75a2 2 0 0 1-2-2V16M7.5 8v8M10.5 8v8M13.5 8v8M16.5 8v8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>;
  if (name === "pencil") return <svg {...common}><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3ZM13.5 7.5l3 3" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" /></svg>;
  return <svg {...common}><path d="m6.5 12.5 3.2 3.2 7.8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>;
}

function Sheet({ title, onClose, children, className = "" }: { title: string; onClose(): void; children: ComponentChildren; className?: string }) {
  return (
    <div class="sheet-layer" role="presentation">
      <button class="sheet-scrim" aria-label="Lukk" onClick={onClose} />
      <section class={`sheet ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <div class="sheet-grabber" aria-hidden="true" />
        <div class="sheet-header">
          <h2>{title}</h2>
          <button class="icon-button" aria-label="Lukk" onClick={onClose}><Icon name="close" /></button>
        </div>
        {children}
      </section>
    </div>
  );
}

/** Each status has its own shape, so it never relies on color alone. */
function StatusIcon({ status }: { status: ItemStatus }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", "aria-hidden": true } as const;
  if (status === "have") return <svg {...common} fill="none"><path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" /></svg>;
  if (status === "soon") return <svg {...common}><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.6" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></svg>;
  return <svg {...common} fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2.6" /></svg>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div class="empty-state"><h2>{title}</h2><p>{text}</p></div>;
}

function EmailSignIn({ title, text }: { title: string; text: string }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: Event) {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return setError("Skriv e-postadressen din.");
    setBusy(true); setError("");
    try {
      await sendSignInCode(normalizedEmail);
      setSent(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Kunne ikke sende innloggingskoden."); }
    finally { setBusy(false); }
  }

  async function verify(event: Event) {
    event.preventDefault();
    const normalizedCode = code.replace(/\s/g, "");
    if (!normalizedCode) return setError("Skriv inn koden fra e-posten.");
    setBusy(true); setError("");
    try {
      await verifySignInCode(email.trim().toLowerCase(), normalizedCode);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Koden kunne ikke bekreftes."); }
    finally { setBusy(false); }
  }

  return <div class="auth-panel">
    <div><p class="eyebrow">Things-konto</p><h2>{title}</h2><p>{text}</p></div>
    {sent ? <form class="onboarding-form auth-code-form" onSubmit={verify}>
      <div class="auth-sent" role="status"><strong>Sjekk e-posten din</strong><p>Skriv inn engangskoden her i Things. Du trenger ikke åpne e-postlenken i nettleseren.</p></div>
      <label>Engangskode<input autofocus value={code} onInput={(event) => setCode(event.currentTarget.value)} inputMode="numeric" autocomplete="one-time-code" maxlength={10} placeholder="123456" /></label>
      {error && <p class="form-error" role="alert">{error}</p>}
      <button class="primary-button" disabled={busy}>{busy ? "Bekrefter …" : "Bekreft kode"}</button>
      <button type="button" class="secondary-button" onClick={() => { setSent(false); setCode(""); setError(""); }}>Bruk en annen e-post</button>
    </form> :
      <form class="onboarding-form" onSubmit={submit}>
        <label>E-post<input type="email" inputMode="email" autocomplete="email" value={email} onInput={(event) => setEmail(event.currentTarget.value)} placeholder="deg@eksempel.no" /></label>
        {error && <p class="form-error" role="alert">{error}</p>}
        <button class="primary-button" disabled={busy}>{busy ? "Sender …" : "Send engangskode"}</button>
      </form>}
  </div>;
}

function Onboarding({ onReady, session, authLoaded }: { onReady(snapshot: AppSnapshot): void; session: AuthSession | null; authLoaded: boolean }) {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const inviteFromUrl = params.get("join") ?? "";
  if (inviteFromUrl) localStorage.setItem(PENDING_INVITE_KEY, inviteFromUrl);
  const pendingMode = localStorage.getItem(PENDING_MODE_KEY);
  const initialMode = inviteFromUrl || pendingMode === "join" ? "join" : params.has("transfer") ? "transfer" : pendingMode === "create" ? "create" : "welcome";
  const [mode, setMode] = useState<"welcome" | "create" | "join" | "transfer">(initialMode);
  const [name, setName] = useState("");
  const [token, setToken] = useState(inviteFromUrl || params.get("transfer") || localStorage.getItem(PENDING_INVITE_KEY) || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function createHome(event: Event) {
    event.preventDefault();
    const displayName = cleanDisplayName(name);
    if (!displayName) return setError("Skriv navnet ditt først.");
    setBusy(true); setError("");
    try {
      if (isRemoteConfigured) {
        if (!session) throw new Error("Logg inn for å opprette et hjem.");
        const result = await createRemoteHome(displayName);
        onReady({ ...structuredClone(EMPTY_SNAPSHOT), identity: result.identity, members: result.members });
      } else {
        const homeId = crypto.randomUUID();
        const memberId = crypto.randomUUID();
        const identity: Identity = { homeId, memberId, deviceId: crypto.randomUUID(), deviceToken: crypto.randomUUID(), displayName };
        const member: Member = { id: memberId, homeId, displayName };
        onReady({ ...structuredClone(EMPTY_SNAPSHOT), identity, members: [member] });
      }
      localStorage.removeItem(PENDING_MODE_KEY);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Kunne ikke opprette hjemmet."); }
    finally { setBusy(false); }
  }

  async function joinHome(event: Event) {
    event.preventDefault();
    const displayName = cleanDisplayName(name);
    if (!displayName || !token.trim()) return setError("Skriv navn og invitasjonskode.");
    setBusy(true); setError("");
    try {
      if (!session) throw new Error("Logg inn for å bli med i hjemmet.");
      const result = await joinRemoteHome(token.trim(), displayName);
      onReady({ ...structuredClone(EMPTY_SNAPSHOT), identity: result.identity, members: result.members });
      localStorage.removeItem(PENDING_MODE_KEY); localStorage.removeItem(PENDING_INVITE_KEY);
      history.replaceState(null, "", location.pathname);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Invitasjonen kunne ikke brukes."); }
    finally { setBusy(false); }
  }

  async function transferHome(event: Event) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await consumeTransfer(token.trim());
      onReady({ ...structuredClone(EMPTY_SNAPSHOT), identity: result.identity, members: result.members });
      history.replaceState(null, "", location.pathname);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Overføringslenken kunne ikke brukes."); }
    finally { setBusy(false); }
  }

  if (mode === "welcome") return (
    <main class="onboarding">
      <div class="wordmark">Things</div>
      <div class="welcome-copy"><h1>Det dere har.<br />Det dere trenger.</h1><p>Oppdater kjøkkenet med én hånd. Handle ut fra den samme, delte listen.</p></div>
      <div class="onboarding-actions">
        <button class="primary-button" onClick={() => { localStorage.setItem(PENDING_MODE_KEY, "create"); setMode("create"); }}>Opprett hjem</button>
        <button class="secondary-button" onClick={() => { localStorage.setItem(PENDING_MODE_KEY, "join"); setMode("join"); }}>Bli med</button>
        {!isRemoteConfigured && <p class="configuration-note">Lokal modus er aktiv til DailyPep Supabase er koblet til.</p>}
      </div>
    </main>
  );

  if (mode === "transfer") return (
    <main class="onboarding form-screen">
      <button class="text-back" onClick={() => setMode("welcome")}>Tilbake</button>
      <div><p class="eyebrow">Ny telefon</p><h1>Hent hjemmet ditt</h1><p>Overføringslenken kan brukes én gang og utløper etter ti minutter.</p></div>
      <form onSubmit={transferHome} class="onboarding-form">
        <label>Overføringskode<input value={token} onInput={(e) => setToken(e.currentTarget.value)} autocomplete="one-time-code" /></label>
        {error && <p class="form-error" role="alert">{error}</p>}
        <button class="primary-button" disabled={busy}>{busy ? "Kobler til …" : "Koble til"}</button>
      </form>
    </main>
  );

  if (isRemoteConfigured && (!authLoaded || !session)) return (
    <main class="onboarding form-screen">
      <button class="text-back" onClick={() => { localStorage.removeItem(PENDING_MODE_KEY); setMode("welcome"); }}>Tilbake</button>
      {!authLoaded ? <div class="auth-loading">Klargjør sikker innlogging …</div> : <EmailSignIn title={mode === "create" ? "Logg inn før du oppretter hjemmet" : "Logg inn før du blir med"} text="Du får en engangskode på e-post og trenger ikke passord." />}
    </main>
  );

  return (
    <main class="onboarding form-screen">
      <button class="text-back" onClick={() => { localStorage.removeItem(PENDING_MODE_KEY); setMode("welcome"); }}>Tilbake</button>
      <div>
        <p class="eyebrow">{mode === "create" ? "Nytt hjem" : "Invitasjon"}</p>
        <h1>{mode === "create" ? "Hva heter du?" : "Bli med i hjemmet"}</h1>
        <p>{mode === "create" ? "Den du inviterer skriver sitt eget navn når invitasjonen åpnes." : "Invitasjonen kan bare brukes én gang."}</p>
        {session?.user.email && <p class="signed-in-note">Innlogget som {session.user.email}</p>}
      </div>
      <form onSubmit={mode === "create" ? createHome : joinHome} class="onboarding-form">
        <label>Navn<input autofocus value={name} onInput={(e) => setName(e.currentTarget.value)} maxlength={60} autocomplete="name" placeholder="Ditt navn" /></label>
        {mode === "join" && <label>Invitasjonskode<input value={token} onInput={(e) => setToken(e.currentTarget.value)} autocomplete="one-time-code" /></label>}
        {error && <p class="form-error" role="alert">{error}</p>}
        <button class="primary-button" disabled={busy}>{busy ? "Et øyeblikk …" : mode === "create" ? "Opprett hjem" : "Bli med"}</button>
      </form>
    </main>
  );
}

export function App() {
  const [loaded, setLoaded] = useState(false);
  const [authLoaded, setAuthLoaded] = useState(!isAuthConfigured);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [accountState, setAccountState] = useState<"idle" | "linking" | "linked" | "error">("idle");
  const [accountError, setAccountError] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const [snapshot, setSnapshot] = useState<AppSnapshot>(structuredClone(EMPTY_SNAPSHOT));
  const snapshotRef = useRef(snapshot);
  const [tab, setTab] = useState<Tab>("cabinet");
  const [query, setQuery] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [showHome, setShowHome] = useState(false);
  const [completed, setCompleted] = useState<Map<string, ItemStatus>>(new Map());
  const [statusFilters, setStatusFilters] = useState<ItemStatus[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [syncState, setSyncState] = useState<SyncState>("ready");
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [deletedItem, setDeletedItem] = useState<Item | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [scanned, setScanned] = useState<ScannedCode | null>(null);
  const scannedRef = useRef<string | null>(null);
  const undoTimer = useRef<number | null>(null);
  const syncTimer = useRef<number | null>(null);
  const syncingRef = useRef(false);
  const claimingRef = useRef(false);

  useEffect(() => {
    loadSnapshot().then((value) => {
      snapshotRef.current = value;
      setSnapshot(value);
      setLoaded(true);
      if (value.identity && isRemoteConfigured && navigator.onLine) window.setTimeout(() => void syncNow(), 0);
    });
    const onOnline = () => { setOnline(true); void syncNow(); };
    const onOffline = () => { setOnline(false); setSyncState("waiting"); };
    const onInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); };
    addEventListener("online", onOnline); addEventListener("offline", onOffline); addEventListener("beforeinstallprompt", onInstall);
    return () => { removeEventListener("online", onOnline); removeEventListener("offline", onOffline); removeEventListener("beforeinstallprompt", onInstall); };
  }, []);

  useEffect(() => {
    let active = true;
    loadAuthSession()
      .then((session) => { if (active) setAuthSession(session); })
      .catch(() => { if (active) setAccountError("Kunne ikke lese innloggingsøkten."); })
      .finally(() => { if (active) setAuthLoaded(true); });
    const unsubscribe = onAuthSessionChanged((session) => {
      setAuthSession(session);
      setAuthLoaded(true);
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!snapshot.identity || !isRemoteConfigured) return;
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) void syncNow();
    }, 20_000);
    const onVisible = () => { if (document.visibilityState === "visible" && navigator.onLine) void syncNow(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(poll); document.removeEventListener("visibilitychange", onVisible); };
  }, [snapshot.identity?.deviceId]);

  useEffect(() => {
    const homeId = snapshot.identity?.homeId;
    setStatusFilters(homeId ? loadStatusFilters(homeId) : []);
  }, [snapshot.identity?.homeId]);

  useEffect(() => {
    if (!authSession || !snapshot.identity || snapshot.identity.accountLinked || claimingRef.current) return;
    void linkCurrentAccount();
  }, [authSession?.user.id, snapshot.identity?.deviceId, snapshot.identity?.accountLinked]);

  function commit(updater: (current: AppSnapshot) => AppSnapshot) {
    setSnapshot((current) => {
      const next = updater(current);
      snapshotRef.current = next;
      void saveSnapshot(next);
      return next;
    });
  }

  function scheduleSync() {
    if (!isRemoteConfigured || !navigator.onLine) { setSyncState("waiting"); return; }
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => void syncNow(), 250);
  }

  async function linkCurrentAccount() {
    const identity = snapshotRef.current.identity;
    if (!identity || !authSession || claimingRef.current) return;
    claimingRef.current = true;
    setAccountState("linking"); setAccountError("");
    try {
      const result = await claimRemoteAccount(identity);
      commit((current) => ({ ...current, identity: result.identity, members: result.members }));
      setAccountState("linked"); setShowAuth(false);
    } catch (cause) {
      setAccountState("error");
      setAccountError(cause instanceof Error ? cause.message : "Kunne ikke koble kontoen.");
    } finally { claimingRef.current = false; }
  }

  async function syncNow() {
    const current = snapshotRef.current;
    if (!isRemoteConfigured || !current.identity || !navigator.onLine || syncingRef.current) return;
    syncingRef.current = true;
    setSyncState("syncing");
    try {
      const result = await syncRemote(current);
      commit((latest) => ({
        ...latest,
        items: mergeItems(latest.items, result.items),
        members: result.members,
        outbox: latest.outbox.filter((mutation) => !result.acceptedMutationIds.includes(mutation.id)),
        syncCursor: Math.max(latest.syncCursor, result.cursor),
      }));
      setSyncState("ready");
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("ikke lenger tilgang")) {
        await resetLocal();
        return;
      }
      setSyncState("error");
    }
    finally { syncingRef.current = false; }
  }

  function initialize(value: AppSnapshot) {
    snapshotRef.current = value; setSnapshot(value); void saveSnapshot(value); scheduleSync();
  }

  const activeItems = useMemo(() => snapshot.items.filter((item) => !item.deletedAt).sort((a, b) => a.name.localeCompare(b.name, "nb-NO")), [snapshot.items]);
  const visibleItems = useMemo(() => {
    const needle = normalizeItemName(query);
    return activeItems.filter((item) =>
      (statusFilters.length === 0 || statusFilters.includes(item.status))
      && (!needle || item.normalizedName.includes(needle)),
    );
  }, [activeItems, query, statusFilters]);
  const shoppingItems = useMemo(() => activeItems.filter((item) => item.status !== "have"), [activeItems]);
  const mustBuy = shoppingItems.filter((item) => item.status === "empty");
  const mayBuy = shoppingItems.filter((item) => item.status === "soon");
  const completedItems = activeItems.filter((item) => completed.has(item.id));
  const selectedItem = snapshot.items.find((item) => item.id === selectedItemId) ?? null;
  const others = snapshot.members.filter((member) => member.id !== snapshot.identity?.memberId);
  const exactMatch = activeItems.find((item) => item.normalizedName === normalizeItemName(query));
  const haveCount = activeItems.length - shoppingItems.length;

  function toggleStatusFilter(status: ItemStatus) {
    setStatusFilters((current) => {
      const next = current.includes(status) ? current.filter((entry) => entry !== status) : [...current, status];
      const homeId = snapshotRef.current.identity?.homeId;
      if (homeId) saveStatusFilters(homeId, next);
      return next;
    });
  }

  function submitQuickEntry(event: Event) {
    event.preventDefault();
    if (exactMatch) { setSelectedItemId(exactMatch.id); setQuery(""); return; }
    addItem();
  }

  function addItem() {
    if (!snapshot.identity || !normalizeItemName(query) || exactMatch) return;
    const item = createItem(snapshot.identity.homeId, snapshot.identity.memberId, query);
    commit((current) => ({ ...current, items: [...current.items, item], outbox: [...current.outbox, itemToMutation(item)] }));
    setQuery(""); navigator.vibrate?.(10); scheduleSync();
  }

  function updateItem(item: Item, changes: Partial<Pick<Item, "name" | "status" | "deletedAt" | "eans">>) {
    if (!snapshot.identity) return;
    const result = mutateItem(item, snapshot.identity.memberId, changes);
    commit((current) => ({
      ...current,
      items: current.items.map((entry) => entry.id === item.id ? result.item : entry),
      outbox: [...current.outbox, result.mutation],
    }));
    navigator.vibrate?.(10); scheduleSync();
  }

  async function handleScan(ean: string) {
    setShowScanner(false);
    const local = findItemByEan(snapshotRef.current.items, ean);
    if (local) { setSelectedItemId(local.id); return; }
    scannedRef.current = ean;
    setScanned({ ean, lookup: null });
    const identity = snapshotRef.current.identity;
    let lookup: ScannedCode["lookup"];
    if (!isRemoteConfigured || !identity) lookup = { name: "", note: "Fant ikke varen. Skriv navnet selv.", fromProduct: false };
    else if (!navigator.onLine) lookup = { name: "", note: "Uten nett. Skriv navnet selv.", fromProduct: false };
    else {
      let result: ProductLookup | null = null;
      try { result = await lookupEan(identity, ean); } catch { /* Same as no hit. */ }
      lookup = result?.product
        ? { name: cleanDisplayName(result.product.name), note: "", fromProduct: true }
        : { name: "", note: result?.rateLimited ? "Mange oppslag akkurat nå. Skriv navnet selv." : "Fant ikke varen. Skriv navnet selv.", fromProduct: false };
    }
    if (scannedRef.current === ean) setScanned({ ean, lookup });
  }

  function closeScanned() { scannedRef.current = null; setScanned(null); }

  /** Adds the scanned code to an existing item, or to a new one, then opens it so status can be set. */
  function finishScan(target: Item | string) {
    const identity = snapshotRef.current.identity;
    if (!identity || !scanned) return;
    const { ean, lookup } = scanned;
    let itemId: string;
    if (typeof target === "string") {
      const item = createItem(identity.homeId, identity.memberId, target, "empty", [ean]);
      commit((current) => ({ ...current, items: [...current.items, item], outbox: [...current.outbox, itemToMutation(item)] }));
      navigator.vibrate?.(10); scheduleSync();
      itemId = item.id;
    } else {
      const fresh = snapshotRef.current.items.find((item) => item.id === target.id) ?? target;
      updateItem(fresh, { eans: addEan(fresh, ean) });
      itemId = target.id;
    }
    const typedName = typeof target === "string" ? target : "";
    if (typedName && lookup && !lookup.fromProduct && isRemoteConfigured && navigator.onLine) {
      void saveProduct(identity, ean, cleanDisplayName(typedName)).catch(() => undefined);
    }
    closeScanned();
    setSelectedItemId(itemId);
  }

  function checkItem(item: Item) {
    setCompleted((current) => new Map(current).set(item.id, item.status));
    updateItem(item, { status: "have" });
  }

  function undoItem(item: Item) {
    const previousStatus = completed.get(item.id) ?? "empty";
    setCompleted((current) => { const next = new Map(current); next.delete(item.id); return next; });
    updateItem(item, { status: previousStatus });
  }

  function deleteItem(item: Item) {
    updateItem(item, { deletedAt: new Date().toISOString() });
    setSelectedItemId(null);
    setDeletedItem(item);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setDeletedItem(null), 5000);
  }

  function undoDelete() {
    if (!deletedItem) return;
    const latest = snapshotRef.current.items.find((entry) => entry.id === deletedItem.id);
    if (latest?.deletedAt) updateItem(latest, { deletedAt: null });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setDeletedItem(null);
  }

  async function resetLocal() {
    snapshotRef.current = structuredClone(EMPTY_SNAPSHOT);
    setSnapshot(structuredClone(EMPTY_SNAPSHOT));
    await clearSnapshot();
    setShowHome(false); setTab("cabinet");
  }

  async function logOutAccount() {
    await signOut();
    setAuthSession(null);
    setAccountState("idle");
  }

  async function removeMember(memberId: string) {
    const identity = snapshotRef.current.identity;
    if (!identity) return;
    const result = await removeRemoteMember(identity, memberId);
    commit((current) => ({ ...current, members: result.members }));
  }

  if (!loaded) return <div class="loading-screen"><div class="wordmark">Things</div></div>;
  if (!snapshot.identity) return <Onboarding onReady={initialize} session={authSession} authLoaded={authLoaded} />;

  return (
    <div class="app-shell">
      {!online && <div class="connection-banner"><Icon name="wifi" /> Frakoblet – endringer lagres på telefonen</div>}
      {online && syncState === "error" && <button class="connection-banner error" onClick={() => void syncNow()}>Kunne ikke synkronisere. Prøv igjen.</button>}
      <header class="page-header">
        <div class="page-title-row">
          <div class="wordmark" aria-hidden="true">Things</div>
          <h1 class="sr-only">{tab === "cabinet" ? "Skapet" : "Handle"}</h1>
          <button class="home-button" aria-label="Hjem" title="Hjem" onClick={() => setShowHome(true)}><Icon name="house" /></button>
        </div>
        {tab === "cabinet" && activeItems.length > 0 && (
          <div class="status-summary" role="group" aria-label="Filtrer skapet etter status">
            <button class={`summary-pill empty ${statusFilters.includes("empty") ? "active" : ""}`} aria-pressed={statusFilters.includes("empty")} onClick={() => toggleStatusFilter("empty")}>{mustBuy.length} må kjøpes</button>
            <button class={`summary-pill soon ${statusFilters.includes("soon") ? "active" : ""}`} aria-pressed={statusFilters.includes("soon")} onClick={() => toggleStatusFilter("soon")}>{mayBuy.length} snart tom</button>
            <button class={`summary-pill have ${statusFilters.includes("have") ? "active" : ""}`} aria-pressed={statusFilters.includes("have")} onClick={() => toggleStatusFilter("have")}>{haveCount} har</button>
          </div>
        )}
        {tab === "cabinet" ? (
          others.length > 0
            ? <button class="shared-home" onClick={() => setShowHome(true)}>Delt med {others.map((member) => member.displayName).join(", ")}</button>
            : <button class="invite-home" onClick={() => setShowHome(true)}><Icon name="person" /><span><strong>Inviter en person</strong><small>Del skapet og handlelisten</small></span></button>
        ) : <p>{shoppingItems.length} {shoppingItems.length === 1 ? "vare" : "varer"}</p>}
      </header>

      <main class={`page-content ${tab}`}>
        {tab === "cabinet" && (
          activeItems.length === 0 ? <EmptyState title="Ingen varer ennå" text="Bruk feltet nederst når du oppdager noe som mangler." /> :
          <div class="edge-list" aria-label="Varer i skapet">
            {visibleItems.map((item) => (
              <button class={`item-row cabinet-row ${item.status}`} key={item.id} onClick={() => setSelectedItemId(item.id)}>
                <span class={`status-dot ${item.status}`} aria-hidden="true" />
                <span class="item-name">{item.name}</span>
                {item.status === "have" ? <span class="sr-only">{STATUS_COPY.have.label}</span> : <span class={`status-label ${item.status}`}>{STATUS_COPY[item.status].label}</span>}
              </button>
            ))}
            {visibleItems.length === 0 && <p class="no-results">{query.trim() ? `Ingen varer passer med «${query.trim()}».` : "Ingen varer har de valgte statusene."}</p>}
          </div>
        )}

        {tab === "shop" && (
          shoppingItems.length === 0 && completedItems.length === 0 ? <EmptyState title="Alt er i hus" text="Når noe blir tomt, dukker det opp her automatisk." /> :
          <div class="shopping-sections">
            {mustBuy.length > 0 && <ShoppingSection title="Må kjøpes" tone="empty" items={mustBuy} onCheck={checkItem} />}
            {mayBuy.length > 0 && <ShoppingSection title="Kan tas med" tone="soon" items={mayBuy} onCheck={checkItem} />}
            {completedItems.length > 0 && (
              <section class="shopping-section completed-section">
                <div class="section-heading"><h2>Ferdig</h2><button onClick={() => setCompleted(new Map())}>Skjul ferdige</button></div>
                <div class="edge-list">{completedItems.map((item) => <div class="item-row completed-row" key={item.id}><span><Icon name="check" /> <s>{item.name}</s></span><button onClick={() => undoItem(item)}>Angre</button></div>)}</div>
              </section>
            )}
          </div>
        )}
      </main>

      <div class={`bottom-dock ${tab === "shop" ? "without-search" : ""}`}>
        {tab === "cabinet" && (
          <div class="dock-row">
            <form class="quick-entry" onSubmit={submitQuickEntry}>
              <Icon name="search" />
              <input aria-label="Finn eller legg til vare" value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Finn eller legg til vare" enterKeyHint="done" />
              {query && !exactMatch && <button type="submit">Legg til</button>}
            </form>
            <button class="scan-button" onClick={() => setShowScanner(true)}><Icon name="barcode" /><span>Skann</span></button>
          </div>
        )}
        <nav class="tab-bar" aria-label="Hovednavigasjon">
          <button class={tab === "cabinet" ? "active" : ""} onClick={() => setTab("cabinet")}><Icon name="cabinet" /><span>Skapet</span></button>
          <button class={tab === "shop" ? "active" : ""} onClick={() => setTab("shop")}><span class="tab-icon-wrap"><Icon name="cart" />{shoppingItems.length > 0 && <span class="badge">{shoppingItems.length}</span>}</span><span>Handle</span></button>
        </nav>
      </div>

      {deletedItem && <div class="undo-toast" role="status"><span>«{deletedItem.name}» er slettet</span><button onClick={undoDelete}>Angre</button></div>}
      {selectedItem && <ItemSheet item={selectedItem} members={snapshot.members} onClose={() => setSelectedItemId(null)} onDelete={() => deleteItem(selectedItem)} onChange={(changes) => { updateItem(selectedItem, changes); if (changes.status) setSelectedItemId(null); }} />}
      {showScanner && <Sheet title="Skann strekkode" onClose={() => setShowScanner(false)}><Scanner onDetected={(ean) => void handleScan(ean)} /><button class="sheet-close" onClick={() => setShowScanner(false)}>Lukk</button></Sheet>}
      {scanned && <NewCodeSheet key={scanned.ean} scanned={scanned} items={activeItems} onLink={finishScan} onCreate={finishScan} onClose={closeScanned} />}
      {showHome && <HomeSheet identity={snapshot.identity} members={snapshot.members} syncState={syncState} online={online} installPrompt={installPrompt} authSession={authSession} accountState={accountState} accountError={accountError} onSecureAccount={() => setShowAuth(true)} onRetryAccount={() => void linkCurrentAccount()} onSignOut={() => void logOutAccount()} onClose={() => setShowHome(false)} onSynced={() => void syncNow()} onRemoveMember={removeMember} onLeave={async () => { if (isRemoteConfigured) await leaveRemoteHome(snapshot.identity!); await resetLocal(); }} onDelete={async () => { if (isRemoteConfigured) await deleteRemoteHome(snapshot.identity!); await resetLocal(); }} />}
      {showAuth && <Sheet title="Sikre kontoen" onClose={() => setShowAuth(false)}><EmailSignIn title="Koble hjemmet til e-posten din" text="Etter innlogging kan dette medlemskapet knyttes til kontoen din uten at varer eller historikk forsvinner." /><button class="sheet-close" onClick={() => setShowAuth(false)}>Lukk</button></Sheet>}
    </div>
  );
}

function ShoppingSection({ title, tone, items, onCheck }: { title: string; tone: "empty" | "soon"; items: Item[]; onCheck(item: Item): void }) {
  return <section class="shopping-section"><div class={`section-heading ${tone}`}><h2>{title}</h2></div><div class="edge-list">{items.map((item) => <button class="item-row shopping-row" key={item.id} onClick={() => onCheck(item)}><span class="item-name">{item.name}</span><span class="check-circle" aria-label="Sett til Har" /></button>)}</div></section>;
}

function ItemSheet({ item, members, onClose, onChange, onDelete }: { item: Item; members: Member[]; onClose(): void; onChange(changes: Partial<Pick<Item, "name" | "status">>): void; onDelete(): void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const changedBy = members.find((member) => member.id === item.changedBy)?.displayName ?? "en i hjemmet";
  return <Sheet title={item.name} onClose={onClose}>
    {!editing ? <>
      <p class="sheet-question">Hva er status hjemme?</p>
      <div class="choice-list">{(["have", "soon", "empty"] as ItemStatus[]).map((status) => <button class={`choice-row ${status} ${item.status === status ? "selected" : ""}`} aria-pressed={item.status === status} onClick={() => onChange({ status })}><span class="choice-icon"><StatusIcon status={status} /></span><span><strong>{STATUS_COPY[status].label}</strong><small>{STATUS_COPY[status].helper}</small></span>{item.status === status ? <span class="choice-tick"><Icon name="check" /></span> : <span />}</button>)}</div>
      <p class="last-changed">Sist endret av {changedBy} {formatRelativeTime(item.changedAt)}</p>
      <div class="sheet-actions">
        <button class="sheet-action" onClick={() => setEditing(true)}><Icon name="pencil" />Endre navn</button>
        <button class="sheet-action danger" onClick={onDelete}><Icon name="trash" />Slett vare</button>
      </div>
      <button class="sheet-close" onClick={onClose}>Lukk</button>
    </> : <>
      <form class="form-group" onSubmit={(event) => { event.preventDefault(); if (!normalizeItemName(name)) return; onChange({ name: cleanDisplayName(name) }); setEditing(false); }}><label>Varenavn<input value={name} onInput={(event) => setName(event.currentTarget.value)} maxlength={60} enterKeyHint="done" /></label><button class="primary-button compact" disabled={!normalizeItemName(name)}>Lagre navn</button></form>
      <button class="sheet-close" onClick={() => setEditing(false)}>Tilbake</button>
    </>}
  </Sheet>;
}

function NewCodeSheet({ scanned, items, onLink, onCreate, onClose }: { scanned: ScannedCode; items: Item[]; onLink(item: Item): void; onCreate(name: string): void; onClose(): void }) {
  const [name, setName] = useState("");
  const [typed, setTyped] = useState(false);
  useEffect(() => { if (scanned.lookup && !typed) setName(scanned.lookup.name); }, [scanned.lookup]);
  const needle = normalizeItemName(name);
  const sameName = needle ? items.find((item) => item.normalizedName === needle) : undefined;
  // Match both ways, so "Tine Lettmelk 1 %" finds "Melk". Show every item when nothing matches.
  const matches = needle ? items.filter((item) => item.normalizedName.includes(needle) || needle.includes(item.normalizedName)) : items;
  const linkable = matches.length > 0 ? matches : items;

  function submit(event: Event) {
    event.preventDefault();
    if (sameName) onLink(sameName);
    else if (needle) onCreate(cleanDisplayName(name));
  }

  return <Sheet title="Ny strekkode" onClose={onClose}>
    <p class="sheet-question" role="status">{!scanned.lookup ? "Slår opp strekkoden …" : scanned.lookup.note || "Gi varen navnet dere bruker."}</p>
    <form class="form-group" onSubmit={submit}>
      <label>Varenavn<input value={name} onInput={(event) => { setTyped(true); setName(event.currentTarget.value); }} maxlength={60} enterKeyHint="done" placeholder="F.eks. Melk" /></label>
      <button class="primary-button" disabled={!needle}>{sameName ? `Koble til «${sameName.name}»` : "Legg til som ny vare"}</button>
    </form>
    {items.length > 0 && <>
      <h3 class="sheet-subheading">Eller koble til en vare dere har</h3>
      <div class="edge-list sheet-list">{linkable.map((item) => <button class="item-row" key={item.id} onClick={() => onLink(item)}><span class="item-name">{item.name}</span><span class="row-action">Koble til</span></button>)}</div>
    </>}
    <p class="scanned-code">Strekkode {scanned.ean}</p>
    <button class="sheet-close" onClick={onClose}>Lukk</button>
  </Sheet>;
}

function HomeSheet({ identity, members, syncState, online, installPrompt, authSession, accountState, accountError, onSecureAccount, onRetryAccount, onSignOut, onClose, onSynced, onRemoveMember, onLeave, onDelete }: { identity: Identity; members: Member[]; syncState: SyncState; online: boolean; installPrompt: InstallPromptEvent | null; authSession: AuthSession | null; accountState: "idle" | "linking" | "linked" | "error"; accountError: string; onSecureAccount(): void; onRetryAccount(): void; onSignOut(): void; onClose(): void; onSynced(): void; onRemoveMember(memberId: string): Promise<void>; onLeave(): Promise<void>; onDelete(): Promise<void> }) {
  const [shareLink, setShareLink] = useState("");
  const [message, setMessage] = useState("");
  const [deleteText, setDeleteText] = useState("");
  const [showDanger, setShowDanger] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<Member | null>(null);
  const [memberError, setMemberError] = useState("");
  const currentMember = members.find((member) => member.id === identity.memberId);
  const isOwner = identity.role === "owner" || currentMember?.role === "owner";

  async function makeLink(kind: "invite" | "transfer") {
    setBusy(true); setMessage("");
    try {
      const result = kind === "invite" ? await createInvite(identity) : await createTransfer(identity);
      const link = `${location.origin}${location.pathname}#${kind === "invite" ? "join" : "transfer"}=${result.token}`;
      setShareLink(link); setMessage(kind === "invite" ? "Invitasjonen varer i 24 timer." : "Lenken varer i 10 minutter.");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Kunne ikke lage lenken."); }
    finally { setBusy(false); }
  }

  async function copyLink() { await navigator.clipboard.writeText(shareLink); setMessage("Lenken er kopiert."); }

  async function shareInvite() {
    if (!shareLink) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Bli med i Things", text: "Bli med i hjemmet mitt i Things.", url: shareLink });
        setMessage("Invitasjonen er delt.");
        return;
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
      }
    }
    await copyLink();
  }

  async function confirmMemberRemoval() {
    if (!memberToRemove) return;
    setBusy(true); setMemberError("");
    try {
      await onRemoveMember(memberToRemove.id);
      setMemberToRemove(null);
    } catch (cause) { setMemberError(cause instanceof Error ? cause.message : "Kunne ikke fjerne medlemmet."); }
    finally { setBusy(false); }
  }

  return <Sheet title="Hjem" onClose={onClose} className="home-sheet">
    <div class="settings-group"><h3>Konto</h3>{authSession ? <><div class="settings-row account-row"><span>{authSession.user.email ?? "Innlogget konto"}</span><small>{identity.accountLinked || accountState === "linked" ? "Sikret" : accountState === "linking" ? "Kobler …" : "Ikke koblet"}</small></div>{accountState === "error" && <button class="settings-action" onClick={onRetryAccount}><span>Prøv å koble kontoen igjen</span><small>Prøv igjen</small></button>}<button class="settings-action" onClick={onSignOut}><span>Logg ut av kontoen</span><small>Hjemmet beholdes lokalt nå</small></button></> : <button class="settings-action invite-action" onClick={onSecureAccount}><span><strong>{identity.accountLinked ? "Logg inn på kontoen" : "Sikre kontoen"}</strong><small>Bruk e-post – uten passord</small></span><Icon name="person" /></button>}</div>
    {accountError && <p class="form-error settings-message">{accountError}</p>}
    <div class="settings-group"><h3>Medlemmer</h3>{members.map((member) => <div class="settings-row member-row"><span>{member.displayName}</span>{isOwner && member.id !== identity.memberId ? <button class="member-remove" disabled={busy} onClick={() => { setMemberError(""); setMemberToRemove(member); }}>Fjern</button> : <small>{member.id === identity.memberId ? (member.role === "owner" ? "Deg · Eier" : "Deg") : member.role === "owner" ? "Eier" : ""}</small>}</div>)}{members.length < MAX_MEMBERS && <button class="settings-action invite-action" disabled={busy || !isRemoteConfigured} onClick={() => void makeLink("invite")}><span><strong>{busy ? "Lager invitasjon …" : "Inviter en person"}</strong><small>Lenken kan brukes én gang</small></span><Icon name="person" /></button>}</div>
    {memberToRemove && <div class="member-confirm" role="alertdialog" aria-label={`Fjern ${memberToRemove.displayName}`}><p><strong>Fjern {memberToRemove.displayName}?</strong></p><p>Personens telefoner mister tilgangen til hjemmet.</p>{memberError && <p class="form-error">{memberError}</p>}<div><button class="secondary-button" disabled={busy} onClick={() => setMemberToRemove(null)}>Avbryt</button><button class="danger-button" disabled={busy} onClick={() => void confirmMemberRemoval()}>{busy ? "Fjerner …" : "Fjern medlem"}</button></div></div>}
    {shareLink && <div class="share-card"><p class="share-intro">Send lenken til personen du vil dele hjemmet med.</p><input readonly value={shareLink} aria-label="Delbar lenke" /><div class="share-actions"><button class="share-primary" onClick={() => void shareInvite()}>Del invitasjon</button><button class="share-secondary" onClick={() => void copyLink()}>Kopier lenke</button></div><p>{message}</p></div>}
    {!shareLink && message && <p class="form-error settings-message">{message}</p>}
    <div class="settings-group"><h3>Things</h3><button class="settings-action" onClick={onSynced}><span>Synkstatus</span><small>{!isRemoteConfigured ? "Lokal modus" : !online ? "Frakoblet" : syncState === "syncing" ? "Synkroniserer …" : syncState === "error" ? "Feil – prøv igjen" : "Oppdatert"}</small></button><button class="settings-action" disabled={busy || !isRemoteConfigured} onClick={() => void makeLink("transfer")}>Overfør til ny telefon</button><button class="settings-action" onClick={() => installPrompt ? void installPrompt.prompt() : setMessage("Bruk «Legg til på Hjem-skjerm» i nettlesermenyen.")}>Installer Things</button><button class="settings-action" onClick={() => setShowPrivacy(true)}>Personvern</button></div>
    <div class="settings-group"><h3>Tilgang</h3><button class="settings-action danger-link" onClick={() => setShowDanger(true)}>Forlat eller slett hjem</button></div>
    {showDanger && <div class="danger-panel"><button class="danger-link" onClick={() => void onLeave()}>Forlat hjem</button><label>Skriv SLETT for å slette hjemmet for alle<input value={deleteText} onInput={(event) => setDeleteText(event.currentTarget.value)} /></label><button class="danger-button" disabled={deleteText !== "SLETT"} onClick={() => void onDelete()}>Slett hjem og alle data</button></div>}
    <button class="sheet-close" onClick={onClose}>Lukk</button>
    {showPrivacy && <Sheet title="Personvern" onClose={() => setShowPrivacy(false)}><div class="privacy-copy"><p>Things lagrer navn, varer og statuser for å holde det delte hjemmet synkronisert. I overgangsperioden lagres en tilfeldig enhetsnøkkel i nettleserens lokale lagring.</p><p>Når du sikrer kontoen, kobles medlemskapet til Supabase-kontoen som hører til e-postadressen din. Varenavn og medlemsnavn brukes aldri til analyse.</p><p>Når et hjem slettes, fjernes hjem, medlemmer, enheter, varer og invitasjoner. Tekniske hendelser kan telles uten fritekst for å oppdage synkfeil og forbedre tjenesten.</p></div><button class="sheet-close" onClick={() => setShowPrivacy(false)}>Lukk</button></Sheet>}
  </Sheet>;
}

