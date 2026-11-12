import { NextResponse } from 'next/server';
import { CLOUD_SYNCED_KEYS, isCloudSyncedKey, type CloudEntry } from '@/lib/cloud-sync-keys';

/**
 * Account-level storage for saved strategies / presets.
 *
 * Identity: the caller sends its Deriv access token; we ask Deriv which
 * trading accounts that token owns and key the data to them, so the same Deriv
 * login sees the same saves on every device. Nothing is trusted from the
 * client except the token, which Deriv itself verifies.
 *
 * Storage: any Redis with the Upstash REST API (Vercel KV / Upstash Redis).
 * Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or Vercel's
 * KV_REST_API_URL + KV_REST_API_TOKEN). Without them this route answers 503
 * and the app keeps working with device-only saves.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_VALUE_BYTES = 256 * 1024;
const TOKEN_CACHE_MS = 5 * 60 * 1000;

const REDIS_URL = () => process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? '';
const REDIS_TOKEN = () => process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? '';

function derivApiBase(): string {
  return process.env.NEXT_PUBLIC_DERIV_ENV === 'preview'
    ? 'https://staging-api.derivws.com/trading/v1/options'
    : 'https://api.derivws.com/trading/v1/options';
}

type RedisCmd = (string | number)[];

async function redisPipeline(cmds: RedisCmd[]): Promise<unknown[]> {
  const res = await fetch(`${REDIS_URL()}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  const out = (await res.json()) as { result?: unknown; error?: string }[];
  return out.map((r) => {
    if (r.error) throw new Error(r.error);
    return r.result;
  });
}

// token -> userKey, so a burst of saves doesn't hit Deriv every time.
const tokenCache = new Map<string, { userKey: string; at: number }>();

async function resolveUserKey(token: string): Promise<string | null> {
  const hit = tokenCache.get(token);
  if (hit && Date.now() - hit.at < TOKEN_CACHE_MS) return hit.userKey;

  const res = await fetch(`${derivApiBase()}/accounts`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Deriv-App-ID': process.env.NEXT_PUBLIC_DERIV_APP_ID ?? '',
    },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: { account_id?: string }[] };
  const ids = (body.data ?? []).map((a) => a.account_id).filter((x): x is string => !!x);
  if (ids.length === 0) return null;

  // One stable key per person even if accounts are added later: reuse the key
  // already attached to any of their accounts, else start one from the first id.
  const existing = (await redisPipeline(ids.map((id) => ['GET', `centurium:acct:${id}`]))) as (string | null)[];
  const userKey = existing.find((v) => !!v) ?? [...ids].sort()[0];
  const missing = ids.filter((_, i) => !existing[i]);
  if (missing.length > 0) {
    await redisPipeline(missing.map((id) => ['SET', `centurium:acct:${id}`, userKey]));
  }

  tokenCache.set(token, { userKey, at: Date.now() });
  return userKey;
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() || null : null;
}

async function authed(req: Request): Promise<{ userKey: string } | NextResponse> {
  if (!REDIS_URL() || !REDIS_TOKEN()) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }
  const token = bearer(req);
  if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const userKey = await resolveUserKey(token);
    if (!userKey) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    return { userKey };
  } catch {
    return NextResponse.json({ error: 'upstream' }, { status: 502 });
  }
}

const hashKey = (userKey: string) => `centurium:sync:${userKey}`;

/** All synced entries for the signed-in user. */
export async function GET(req: Request) {
  const a = await authed(req);
  if (a instanceof NextResponse) return a;
  try {
    const [flat] = (await redisPipeline([['HGETALL', hashKey(a.userKey)]])) as [string[] | null];
    const entries: Record<string, CloudEntry> = {};
    for (let i = 0; flat && i + 1 < flat.length; i += 2) {
      const field = flat[i];
      if (!isCloudSyncedKey(field)) continue;
      try {
        const parsed = JSON.parse(flat[i + 1]) as CloudEntry;
        if (typeof parsed.updatedAt === 'number') entries[field] = parsed;
      } catch {
        // skip a corrupt field
      }
    }
    return NextResponse.json({ entries });
  } catch {
    return NextResponse.json({ error: 'upstream' }, { status: 502 });
  }
}

/** Save one entry: { key, value (string | null), updatedAt }. Newer timestamp wins. */
export async function PUT(req: Request) {
  const a = await authed(req);
  if (a instanceof NextResponse) return a;

  let body: { key?: unknown; value?: unknown; updatedAt?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const { key, value, updatedAt } = body;
  if (
    typeof key !== 'string' ||
    !isCloudSyncedKey(key) ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt) ||
    !(value === null || typeof value === 'string') ||
    (typeof value === 'string' && value.length > MAX_VALUE_BYTES)
  ) {
    return NextResponse.json({ error: 'bad_request', allowed: CLOUD_SYNCED_KEYS }, { status: 400 });
  }

  try {
    const [current] = (await redisPipeline([['HGET', hashKey(a.userKey), key]])) as [string | null];
    if (current) {
      try {
        const prev = JSON.parse(current) as CloudEntry;
        if (typeof prev.updatedAt === 'number' && prev.updatedAt > updatedAt) {
          return NextResponse.json({ ok: true, stale: true, entry: prev });
        }
      } catch {
        // overwrite a corrupt field
      }
    }
    const entry: CloudEntry = { value, updatedAt };
    await redisPipeline([['HSET', hashKey(a.userKey), key, JSON.stringify(entry)]]);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'upstream' }, { status: 502 });
  }
}
