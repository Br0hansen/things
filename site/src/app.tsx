import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import {
  cleanDisplayName,
  createItem,
  formatRelativeTime,
  itemToMutation,
  mergeItems,
  mutateItem,
  normalizeItemName,
} from "./lib/domain";
import {
  consumeTransfer,
  createInvite,
  createRemoteHome,
  createTransfer,
  deleteRemoteHome,
  isRemoteConfigured,
  joinRemoteHome,
  leaveRemoteHome,
  syncRemote,
} from "./lib/api";
import { clearSnapshot, loadSnapshot, saveSnapshot } from "./storage/indexed-db";
import { EMPTY_SNAPSHOT, type AppSnapshot, type Identity, type Item, type ItemStatus, type Member } from "./types";

type Tab = "cabinet" | "shop";
type SyncState = "ready" | "syncing" | "waiting" | "error";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const MAX_MEMBERS = 6; // Keep in sync with things-api and things_join_invite.

const STATUS_COPY: Record<ItemStatus, { label: string; helper: string }> = {
  have: { label: "Har", helper: "Vi har nok" },
  soon: { label: "Snart tom", helper: "Kan tas med" },
  empty: { label: "Tom", helper: "Må kjøpes" },
};

function Icon({ name }: { name: "cabinet" | "cart" | "search" | "close" | "check" | "wifi" | "person" | "house" | "trash" | "pencil" }) {
  const common = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true } as const;
  if (name === "cabinet") return <svg {...common}><path d="M5 3.75h14v16.5H5zM12 3.75v16.5M9.2 11.5h.1M14.7 11.5h.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>;
  if (name === "cart") return <svg {...common}><path d="M3.5 5h2l1.8 9.2h10.8l2-6.3H6.1M9 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM17 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>;
  if (name === "search") return <svg {...common}><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="1.8" /><path d="m15.5 15.5 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>;
  if (name === "close") return <svg {...common}><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>;
  if (name === "wifi") return <svg {...common}><path d="M4 9a12 12 0 0 1 16 0M7 12a7.5 7.5 0 0 1 10 0M10 15a3 3 0 0 1 4 0M12 18h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>;
  if (name === "person") return <svg {...common}><circle cx="9" cy="8" r="3.25" stroke="currentColor" stroke-width="1.8" /><path d="M3.75 18.5c.45-3.25 2.2-5 5.25-5s4.8 1.75 5.25 5M17.5 8.5v6M14.5 11.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>;
  if (name === "house") return <svg {...common}><path d="M4 10.5 12 4l8 6.5M6.25 9v10.25h11.5V9M10 19.25v-5h4v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>;
  if (name === "trash") return <svg {...common}><path d="M4.5 7h15M9.5 7V4.75h5V7M6.5 7l.9 12.25h9.2L17.5 7M10 11v5M14 11v5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" /></svg>;
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

function StatusChip({ status }: { status: ItemStatus }) {
  return <span class={`status-chip ${status}`}><StatusIcon status={status} />{STATUS_COPY[status].label}</span>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div class="empty-state"><h2>{title}</h2><p>{text}</p></div>;
}

function Onboarding({ onReady }: { onReady(snapshot: AppSnapshot): void }) {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const initialMode = params.has("join") ? "join" : params.has("transfer") ? "transfer" : "welcome";
  const [mode, setMode] = useState<"welcome" | "create" | "join" | "transfer">(initialMode);
  const [name, setName] = useState("");
  const [token, setToken] = useState(params.get("join") ?? params.get("transfer") ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function createHome(event: Event) {
    event.preventDefault();
    const displayName = cleanDisplayName(name);
    if (!displayName) return setError("Skriv navnet ditt først.");
    setBusy(true); setError("");
    try {
      if (isRemoteConfigured) {
        const result = await createRemoteHome(displayName);
        onReady({ ...structuredClone(EMPTY_SNAPSHOT), identity: result.identity, members: result.members });
      } else {
        const homeId = crypto.randomUUID();
        const memberId = crypto.randomUUID();
        const identity: Identity = { homeId, memberId, deviceId: crypto.randomUUID(), deviceToken: crypto.randomUUID(), displayName };
        const member: Member = { id: memberId, homeId, displayName };
        onReady({ ...structuredClone(EMPTY_SNAPSHOT), identity, members: [member] });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Kunne ikke opprette hjemmet."); }
    finally { setBusy(false); }
  }

  async function joinHome(event: Event) {
    event.preventDefault();
    const displayName = cleanDisplayName(name);
    if (!displayName || !token.trim()) return setError("Skriv navn og invitasjonskode.");
    setBusy(true); setError("");
    try {
      const result = await joinRemoteHome(token.trim(), displayName);
      onReady({ ...structuredClone(EMPTY_SNAPSHOT), identity: result.identity, members: result.members });
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
        <button class="primary-button" onClick={() => setMode("create")}>Opprett hjem</button>
        <button class="secondary-button" onClick={() => setMode("join")}>Bli med</button>
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

  return (
    <main class="onboarding form-screen">
      <button class="text-back" onClick={() => setMode("welcome")}>Tilbake</button>
      <div>
        <p class="eyebrow">{mode === "create" ? "Nytt hjem" : "Invitasjon"}</p>
        <h1>{mode === "create" ? "Hva heter du?" : "Bli med i hjemmet"}</h1>
        <p>{mode === "create" ? "Den du inviterer skriver sitt eget navn når invitasjonen åpnes." : "Invitasjonen kan bare brukes én gang."}</p>
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
  const [snapshot, setSnapshot] = useState<AppSnapshot>(structuredClone(EMPTY_SNAPSHOT));
  const snapshotRef = useRef(snapshot);
  const [tab, setTab] = useState<Tab>("cabinet");
  const [query, setQuery] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [showHome, setShowHome] = useState(false);
  const [completed, setCompleted] = useState<Map<string, ItemStatus>>(new Map());
  const [online, setOnline] = useState(navigator.onLine);
  const [syncState, setSyncState] = useState<SyncState>("ready");
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [deletedItem, setDeletedItem] = useState<Item | null>(null);
  const undoTimer = useRef<number | null>(null);
  const syncTimer = useRef<number | null>(null);
  const syncingRef = useRef(false);

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
    if (!snapshot.identity || !isRemoteConfigured) return;
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) void syncNow();
    }, 20_000);
    const onVisible = () => { if (document.visibilityState === "visible" && navigator.onLine) void syncNow(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(poll); document.removeEventListener("visibilitychange", onVisible); };
  }, [snapshot.identity?.deviceId]);

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
    } catch { setSyncState("error"); }
    finally { syncingRef.current = false; }
  }

  function initialize(value: AppSnapshot) {
    snapshotRef.current = value; setSnapshot(value); void saveSnapshot(value); scheduleSync();
  }

  const activeItems = useMemo(() => snapshot.items.filter((item) => !item.deletedAt).sort((a, b) => a.name.localeCompare(b.name, "nb-NO")), [snapshot.items]);
  const visibleItems = useMemo(() => {
    const needle = normalizeItemName(query);
    return needle ? activeItems.filter((item) => item.normalizedName.includes(needle)) : activeItems;
  }, [activeItems, query]);
  const shoppingItems = useMemo(() => activeItems.filter((item) => item.status !== "have"), [activeItems]);
  const mustBuy = shoppingItems.filter((item) => item.status === "empty");
  const mayBuy = shoppingItems.filter((item) => item.status === "soon");
  const completedItems = activeItems.filter((item) => completed.has(item.id));
  const selectedItem = snapshot.items.find((item) => item.id === selectedItemId) ?? null;
  const others = snapshot.members.filter((member) => member.id !== snapshot.identity?.memberId);
  const exactMatch = activeItems.find((item) => item.normalizedName === normalizeItemName(query));
  const haveCount = activeItems.length - shoppingItems.length;

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

  function updateItem(item: Item, changes: Partial<Pick<Item, "name" | "status" | "deletedAt">>) {
    if (!snapshot.identity) return;
    const result = mutateItem(item, snapshot.identity.memberId, changes);
    commit((current) => ({
      ...current,
      items: current.items.map((entry) => entry.id === item.id ? result.item : entry),
      outbox: [...current.outbox, result.mutation],
    }));
    navigator.vibrate?.(10); scheduleSync();
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

  if (!loaded) return <div class="loading-screen"><div class="wordmark">Things</div></div>;
  if (!snapshot.identity) return <Onboarding onReady={initialize} />;

  return (
    <div class="app-shell">
      {!online && <div class="connection-banner"><Icon name="wifi" /> Frakoblet – endringer lagres på telefonen</div>}
      {online && syncState === "error" && <button class="connection-banner error" onClick={() => void syncNow()}>Kunne ikke synkronisere. Prøv igjen.</button>}
      <header class="page-header">
        <div class="page-title-row">
          <h1>{tab === "cabinet" ? "Skapet" : "Handle"}</h1>
          <button class="home-button" aria-label="Hjem" title="Hjem" onClick={() => setShowHome(true)}><Icon name="house" /></button>
        </div>
        {tab === "cabinet" && activeItems.length > 0 && (
          <button class="status-summary" aria-label={`${mustBuy.length} må kjøpes, ${mayBuy.length} snart tom, ${haveCount} har. Gå til Handle.`} onClick={() => setTab("shop")}>
            {mustBuy.length > 0 && <span class="summary-pill empty">{mustBuy.length} må kjøpes</span>}
            {mayBuy.length > 0 && <span class="summary-pill soon">{mayBuy.length} snart tom</span>}
            {haveCount > 0 && <span class="summary-pill have">{haveCount} har</span>}
          </button>
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
              <button class="item-row" key={item.id} onClick={() => setSelectedItemId(item.id)}>
                <span class="item-name">{item.name}</span>
                <StatusChip status={item.status} />
              </button>
            ))}
            {visibleItems.length === 0 && <p class="no-results">Ingen varer passer med «{query.trim()}».</p>}
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
          <form class="quick-entry" onSubmit={submitQuickEntry}>
            <Icon name="search" />
            <input aria-label="Finn eller legg til vare" value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Finn eller legg til vare" enterKeyHint="done" />
            {query && !exactMatch && <button type="submit">Legg til</button>}
          </form>
        )}
        <nav class="tab-bar" aria-label="Hovednavigasjon">
          <button class={tab === "cabinet" ? "active" : ""} onClick={() => setTab("cabinet")}><Icon name="cabinet" /><span>Skapet</span></button>
          <button class={tab === "shop" ? "active" : ""} onClick={() => setTab("shop")}><span class="tab-icon-wrap"><Icon name="cart" />{shoppingItems.length > 0 && <span class="badge">{shoppingItems.length}</span>}</span><span>Handle</span></button>
        </nav>
      </div>

      {deletedItem && <div class="undo-toast" role="status"><span>«{deletedItem.name}» er slettet</span><button onClick={undoDelete}>Angre</button></div>}
      {selectedItem && <ItemSheet item={selectedItem} members={snapshot.members} onClose={() => setSelectedItemId(null)} onDelete={() => deleteItem(selectedItem)} onChange={(changes) => { updateItem(selectedItem, changes); if (changes.status) setSelectedItemId(null); }} />}
      {showHome && <HomeSheet identity={snapshot.identity} members={snapshot.members} syncState={syncState} online={online} installPrompt={installPrompt} onClose={() => setShowHome(false)} onSynced={() => void syncNow()} onLeave={async () => { if (isRemoteConfigured) await leaveRemoteHome(snapshot.identity!); await resetLocal(); }} onDelete={async () => { if (isRemoteConfigured) await deleteRemoteHome(snapshot.identity!); await resetLocal(); }} />}
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

function HomeSheet({ identity, members, syncState, online, installPrompt, onClose, onSynced, onLeave, onDelete }: { identity: Identity; members: Member[]; syncState: SyncState; online: boolean; installPrompt: InstallPromptEvent | null; onClose(): void; onSynced(): void; onLeave(): Promise<void>; onDelete(): Promise<void> }) {
  const [shareLink, setShareLink] = useState("");
  const [message, setMessage] = useState("");
  const [deleteText, setDeleteText] = useState("");
  const [showDanger, setShowDanger] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [busy, setBusy] = useState(false);

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

  return <Sheet title="Hjem" onClose={onClose} className="home-sheet">
    <div class="settings-group"><h3>Medlemmer</h3>{members.map((member) => <div class="settings-row"><span>{member.displayName}</span>{member.id === identity.memberId && <small>Deg</small>}</div>)}{members.length < MAX_MEMBERS && <button class="settings-action invite-action" disabled={busy || !isRemoteConfigured} onClick={() => void makeLink("invite")}><span><strong>{busy ? "Lager invitasjon …" : "Inviter en person"}</strong><small>Lenken kan brukes én gang</small></span><Icon name="person" /></button>}</div>
    {shareLink && <div class="share-card"><p class="share-intro">Send lenken til personen du vil dele hjemmet med.</p><input readonly value={shareLink} aria-label="Delbar lenke" /><div class="share-actions"><button class="share-primary" onClick={() => void shareInvite()}>Del invitasjon</button><button class="share-secondary" onClick={() => void copyLink()}>Kopier lenke</button></div><p>{message}</p></div>}
    {!shareLink && message && <p class="form-error settings-message">{message}</p>}
    <div class="settings-group"><h3>Things</h3><button class="settings-action" onClick={onSynced}><span>Synkstatus</span><small>{!isRemoteConfigured ? "Lokal modus" : !online ? "Frakoblet" : syncState === "syncing" ? "Synkroniserer …" : syncState === "error" ? "Feil – prøv igjen" : "Oppdatert"}</small></button><button class="settings-action" disabled={busy || !isRemoteConfigured} onClick={() => void makeLink("transfer")}>Overfør til ny telefon</button><button class="settings-action" onClick={() => installPrompt ? void installPrompt.prompt() : setMessage("Bruk «Legg til på Hjem-skjerm» i nettlesermenyen.")}>Installer Things</button><button class="settings-action" onClick={() => setShowPrivacy(true)}>Personvern</button></div>
    <div class="settings-group"><h3>Tilgang</h3><button class="settings-action danger-link" onClick={() => setShowDanger(true)}>Forlat eller slett hjem</button></div>
    {showDanger && <div class="danger-panel"><button class="danger-link" onClick={() => void onLeave()}>Forlat hjem</button><label>Skriv SLETT for å slette hjemmet for alle<input value={deleteText} onInput={(event) => setDeleteText(event.currentTarget.value)} /></label><button class="danger-button" disabled={deleteText !== "SLETT"} onClick={() => void onDelete()}>Slett hjem og alle data</button></div>}
    <button class="sheet-close" onClick={onClose}>Lukk</button>
    {showPrivacy && <Sheet title="Personvern" onClose={() => setShowPrivacy(false)}><div class="privacy-copy"><p>Things lagrer navn, varer og statuser for å holde det delte hjemmet synkronisert. Appen lagrer en kryptert enhetsnøkkel lokalt.</p><p>Varenavn og medlemsnavn brukes aldri til analyse. Når et hjem slettes, fjernes hjem, medlemmer, enheter, varer og invitasjoner.</p><p>Tekniske hendelser kan telles uten fritekst for å oppdage synkfeil og forbedre tjenesten.</p></div><button class="sheet-close" onClick={() => setShowPrivacy(false)}>Lukk</button></Sheet>}
  </Sheet>;
}

