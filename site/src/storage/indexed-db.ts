import { EMPTY_SNAPSHOT, type AppSnapshot } from "../types";

const DB_NAME = "things-local";
const STORE_NAME = "app-state";
const SNAPSHOT_KEY = "snapshot";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadSnapshot(): Promise<AppSnapshot> {
  if (!("indexedDB" in globalThis)) return structuredClone(EMPTY_SNAPSHOT);
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
    request.onsuccess = () => resolve(request.result ?? structuredClone(EMPTY_SNAPSHOT));
    request.onerror = () => reject(request.error);
  });
}

export async function saveSnapshot(snapshot: AppSnapshot): Promise<void> {
  if (!("indexedDB" in globalThis)) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(snapshot, SNAPSHOT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearSnapshot(): Promise<void> {
  if (!("indexedDB" in globalThis)) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(SNAPSHOT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

