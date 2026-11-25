/**
 * A budget for the app's own requests to Facebook (looking up a video or page, fetching a picture), so a
 * burst — a bulk add of dozens of links, a stuck retry loop — can't hammer Facebook and get this server
 * blocked. Over the limit, the request is refused with a plain-language answer and a Retry-After.
 * Without a store (tests, local) nothing is limited.
 * Lookups (the video and page lookups) are the heavy ones; pictures are lighter, so their limit is looser.
 *
 * The shared KV store allows only 1,000 writes a day on the free plan, and your saved data needs them too.
 * So counting must not write on every request: the minute count lives in memory (it only matters for a
 * few seconds), and the day count is kept in memory and written to the store only every few requests
 * (and read back now and then, to pick up what other copies of the Worker counted).
 */
export type FbKind = "lookup" | "image";

export const FB_LIMITS: Record<FbKind, { minute: number; day: number }> = {
  lookup: { minute: 40, day: 1500 },
  image: { minute: 300, day: 5000 },
};

/** The day count is written to the store once per this many requests (at most ~150 + ~50 writes a day). */
const FLUSH_EVERY: Record<FbKind, number> = { lookup: 10, image: 100 };
const REREAD_MS = 60_000;

export interface FbUse {
  minute: number;
  day: number;
  limits: { minute: number; day: number };
}

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const minuteOf = (now: number) => Math.floor(now / 60000);
const keyDay = (kind: FbKind, now: number) => `fbb:${kind}:d:${dayOf(now)}`;

type Store = Pick<KVNamespace, "get" | "put">;

interface Mem {
  minutes: Map<string, number>; // "kind:minute" → requests counted in this copy of the Worker
  days: Map<string, { n: number; flushed: number; readAt: number }>; // store key → running day count
}
const mems = new WeakMap<object, Mem>();
const memOf = (kv: Store): Mem => {
  const had = mems.get(kv);
  if (had) return had;
  const m: Mem = { minutes: new Map(), days: new Map() };
  mems.set(kv, m);
  return m;
};

/** The day's running count: what this copy counted, or what the store holds if that's more (refreshed now and then). */
async function dayEntry(kv: Store, mem: Mem, kind: FbKind, now: number) {
  const key = keyDay(kind, now);
  let e = mem.days.get(key);
  if (!e) {
    e = { n: 0, flushed: 0, readAt: 0 };
    mem.days.set(key, e);
    for (const k of mem.days.keys()) if (k !== key && !k.endsWith(dayOf(now))) mem.days.delete(k); // yesterday's
  }
  if (now - e.readAt >= REREAD_MS || now < e.readAt) {
    e.readAt = now;
    try {
      const stored = Number((await kv.get(key)) ?? 0);
      if (stored > e.n) {
        e.n = stored;
        e.flushed = stored;
      }
    } catch {
      // the store can't be read right now: count with what this copy knows
    }
  }
  return { key, e };
}

export async function fbUse(kv: Store | undefined, kind: FbKind, now = Date.now()): Promise<FbUse> {
  if (!kv) return { minute: 0, day: 0, limits: FB_LIMITS[kind] };
  const mem = memOf(kv);
  const { e } = await dayEntry(kv, mem, kind, now);
  return { minute: mem.minutes.get(`${kind}:${minuteOf(now)}`) ?? 0, day: e.n, limits: FB_LIMITS[kind] };
}

export type Spend = { ok: true } | { ok: false; why: "minute" | "day"; wait: number; message: string };

/** Counts one request, or says why it can't be made right now. */
export async function spendFb(kv: Store | undefined, kind: FbKind, now = Date.now()): Promise<Spend> {
  if (!kv) return { ok: true };
  const mem = memOf(kv);
  const limits = FB_LIMITS[kind];
  const { key, e } = await dayEntry(kv, mem, kind, now);
  const mKey = `${kind}:${minuteOf(now)}`;
  const minute = mem.minutes.get(mKey) ?? 0;
  const what = kind === "lookup" ? "Facebook lookups" : "Facebook pictures";
  if (e.n >= limits.day) {
    const wait = Math.max(60, Math.ceil((Date.parse(`${dayOf(now)}T00:00:00Z`) + 86400000 - now) / 1000));
    return {
      ok: false,
      why: "day",
      wait,
      message: `Today's limit of ${limits.day.toLocaleString()} ${what} is used up. It starts again at midnight (UTC). This keeps Facebook from blocking the app.`,
    };
  }
  if (minute >= limits.minute) {
    const wait = Math.max(1, 60 - Math.floor((now % 60000) / 1000));
    return {
      ok: false,
      why: "minute",
      wait,
      message: `Slow down: that's ${limits.minute} ${what} in a minute, the limit that keeps Facebook happy. Try again in ${wait} seconds.`,
    };
  }
  for (const k of mem.minutes.keys()) if (!k.endsWith(`:${minuteOf(now)}`)) mem.minutes.delete(k); // old minutes
  mem.minutes.set(mKey, minute + 1);
  e.n += 1;
  if (e.n - e.flushed >= FLUSH_EVERY[kind] || e.n >= limits.day) {
    try {
      await kv.put(key, String(e.n), { expirationTtl: 172800 });
      e.flushed = e.n;
    } catch {
      // a full or unreachable store must never break Facebook lookups: keep counting in memory
    }
  }
  return { ok: true };
}
