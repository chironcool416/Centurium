'use client';

import { getAuthInfo } from '@deriv/core';
import {
  CLOUD_SYNC_EVENT,
  CLOUD_SYNCED_KEYS,
  isCloudSyncedKey,
  type CloudEntry,
} from '@/lib/cloud-sync-keys';

/**
 * Mirrors saved strategies (presets, saved settings, named profiles) between
 * this browser's localStorage and the user's account on the server, so the
 * same Deriv login sees the same saves on every device.
 *
 * localStorage stays the source the UI reads (fast, works offline). Every
 * write goes through `cloudSetItem` / `cloudRemoveItem`, which also pushes it
 * to the account; `cloudPull` merges the account's copy back in on login and
 * when the tab regains focus. Last write wins per key, judged by timestamps.
 */

const META_KEY = 'centurium:cloud-meta'; // { [key]: updatedAt of the local copy }
const PUSH_DEBOUNCE_MS = 500;

type Meta = Record<string, number>;

function readMeta(): Meta {
  try {
    const raw = window.localStorage.getItem(META_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Meta) : {};
  } catch {
    return {};
  }
}

function writeMeta(meta: Meta): void {
  try {
    window.localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    // ignore
  }
}

function authHeader(): Record<string, string> | null {
  try {
    const info = getAuthInfo();
    return info ? { Authorization: `Bearer ${info.access_token}` } : null;
  } catch {
    return null;
  }
}

// Set once the server says it has no storage configured, so we stop trying.
let disabled = false;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

async function pushKey(key: string): Promise<void> {
  if (disabled) return;
  const headers = authHeader();
  if (!headers) return; // not signed in (or token expired): the next pull retries
  const updatedAt = readMeta()[key];
  if (!updatedAt) return;
  let value: string | null = null;
  try {
    value = window.localStorage.getItem(key);
  } catch {
    return;
  }
  try {
    const res = await fetch('/api/sync', {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value, updatedAt }),
    });
    if (res.status === 503) disabled = true;
  } catch {
    // offline: the local copy is newer than the cloud's, so the next pull pushes it
  }
}

function schedulePush(key: string): void {
  const t = timers.get(key);
  if (t) clearTimeout(t);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void pushKey(key);
    }, PUSH_DEBOUNCE_MS)
  );
}

function stamp(key: string): void {
  const meta = readMeta();
  meta[key] = Date.now();
  writeMeta(meta);
}

/** Drop-in for localStorage.setItem that also saves to the account. Throws like setItem if storage is full. */
export function cloudSetItem(key: string, value: string): void {
  window.localStorage.setItem(key, value);
  if (!isCloudSyncedKey(key)) return;
  stamp(key);
  schedulePush(key);
}

/** Drop-in for localStorage.removeItem that also removes it from the account. */
export function cloudRemoveItem(key: string): void {
  window.localStorage.removeItem(key);
  if (!isCloudSyncedKey(key)) return;
  stamp(key);
  schedulePush(key);
}

/** Union two JSON collections from different devices that have never synced with each other. */
function mergeFirstSync(key: string, localRaw: string, remoteRaw: string): string {
  try {
    const l = JSON.parse(localRaw);
    const r = JSON.parse(remoteRaw);
    if (Array.isArray(l) && Array.isArray(r)) {
      // presets: keep both, matched by id (newer savedAt wins)
      const byId = new Map<string, { id: string; savedAt?: number }>();
      for (const p of [...r, ...l]) {
        if (!p || typeof p.id !== 'string') continue;
        const prev = byId.get(p.id);
        if (!prev || (p.savedAt ?? 0) >= (prev.savedAt ?? 0)) byId.set(p.id, p);
      }
      return JSON.stringify([...byId.values()]);
    }
    if (l && r && typeof l === 'object' && typeof r === 'object' && !Array.isArray(l) && !Array.isArray(r)) {
      // named profiles: keep both, matched by name (newer savedAt wins)
      const out: Record<string, { savedAt?: number }> = { ...r };
      for (const [name, p] of Object.entries(l as Record<string, { savedAt?: number }>)) {
        const prev = out[name];
        if (!prev || (p?.savedAt ?? 0) >= (prev?.savedAt ?? 0)) out[name] = p;
      }
      // Only collections of {savedAt} objects are merged this way; anything else falls through.
      const looksLikeProfiles = Object.values(out).every((v) => v && typeof v === 'object');
      if (looksLikeProfiles) return JSON.stringify(out);
    }
  } catch {
    // fall through
  }
  return remoteRaw;
}

let pulling: Promise<boolean> | null = null;

/**
 * Bring the account's saves into this browser and send up anything newer
 * that only exists here. Resolves true if local storage changed (the UI
 * should then re-read it — see CLOUD_SYNC_EVENT).
 */
export function cloudPull(): Promise<boolean> {
  if (pulling) return pulling;
  pulling = (async () => {
    if (disabled) return false;
    const headers = authHeader();
    if (!headers) return false;

    let entries: Record<string, CloudEntry>;
    try {
      const res = await fetch('/api/sync', { headers, cache: 'no-store' });
      if (res.status === 503) {
        disabled = true;
        return false;
      }
      if (!res.ok) return false;
      entries = ((await res.json()) as { entries?: Record<string, CloudEntry> }).entries ?? {};
    } catch {
      return false;
    }

    const meta = readMeta();
    let changed = false;
    const toPush: string[] = [];

    for (const key of CLOUD_SYNCED_KEYS) {
      const remote = entries[key];
      const localRaw = window.localStorage.getItem(key);
      const localAt = meta[key];

      if (!remote) {
        // Nothing in the account yet: upload what this device already has.
        if (localRaw !== null) {
          if (!localAt) meta[key] = Date.now();
          toPush.push(key);
        }
        continue;
      }

      if (localAt && localAt > remote.updatedAt) {
        toPush.push(key); // this device is newer
        continue;
      }

      if (localAt === undefined && localRaw !== null && remote.value !== null && localRaw !== remote.value) {
        // First time this device meets the account's copy: keep both sides' saves.
        const merged = mergeFirstSync(key, localRaw, remote.value);
        if (merged !== localRaw) {
          window.localStorage.setItem(key, merged);
          changed = true;
        }
        meta[key] = Date.now();
        toPush.push(key);
        continue;
      }

      if (remote.updatedAt === localAt) continue; // already in step

      // The account's copy is newer (or this device never wrote): take it.
      if (remote.value === null) {
        if (localRaw !== null) {
          window.localStorage.removeItem(key);
          changed = true;
        }
      } else if (remote.value !== localRaw) {
        window.localStorage.setItem(key, remote.value);
        changed = true;
      }
      meta[key] = remote.updatedAt;
    }

    writeMeta(meta);
    for (const key of toPush) void pushKey(key);
    if (changed) window.dispatchEvent(new CustomEvent(CLOUD_SYNC_EVENT));
    return changed;
  })().finally(() => {
    pulling = null;
  });
  return pulling;
}
