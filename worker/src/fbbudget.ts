/**
 * A budget for the app's own requests to Facebook (looking up a video or page, fetching a picture), so a
 * burst — a bulk add of dozens of links, a stuck retry loop — can't hammer Facebook and get this server
 * blocked. Counted in the shared KV store; over the limit, the request is refused with a plain-language
 * answer and a Retry-After. Without a store (tests, local) nothing is limited.
 * Lookups (the video and page lookups) are the heavy ones; pictures are lighter, so their limit is looser.
 */
export type FbKind = "lookup" | "image";

export const FB_LIMITS: Record<FbKind, { minute: number; day: number }> = {
  lookup: { minute: 40, day: 1500 },
  image: { minute: 300, day: 5000 },
};

export interface FbUse {
  minute: number;
  day: number;
  limits: { minute: number; day: number };
}

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const keyMinute = (kind: FbKind, now: number) => `fbb:${kind}:m:${Math.floor(now / 60000)}`;
const keyDay = (kind: FbKind, now: number) => `fbb:${kind}:d:${dayOf(now)}`;

type Store = Pick<KVNamespace, "get" | "put">;

export async function fbUse(kv: Store | undefined, kind: FbKind, now = Date.now()): Promise<FbUse> {
  const [m, d] = kv ? await Promise.all([kv.get(keyMinute(kind, now)), kv.get(keyDay(kind, now))]) : [null, null];
  return { minute: Number(m ?? 0), day: Number(d ?? 0), limits: FB_LIMITS[kind] };
}

export type Spend = { ok: true } | { ok: false; why: "minute" | "day"; wait: number; message: string };

/** Counts one request, or says why it can't be made right now. */
export async function spendFb(kv: Store | undefined, kind: FbKind, now = Date.now()): Promise<Spend> {
  if (!kv) return { ok: true };
  const use = await fbUse(kv, kind, now);
  const what = kind === "lookup" ? "Facebook lookups" : "Facebook pictures";
  if (use.day >= use.limits.day) {
    const wait = Math.max(60, Math.ceil((Date.parse(`${dayOf(now)}T00:00:00Z`) + 86400000 - now) / 1000));
    return {
      ok: false,
      why: "day",
      wait,
      message: `Today's limit of ${use.limits.day.toLocaleString()} ${what} is used up. It starts again at midnight (UTC). This keeps Facebook from blocking the app.`,
    };
  }
  if (use.minute >= use.limits.minute) {
    const wait = Math.max(1, 60 - Math.floor((now % 60000) / 1000));
    return {
      ok: false,
      why: "minute",
      wait,
      message: `Slow down: that's ${use.limits.minute} ${what} in a minute, the limit that keeps Facebook happy. Try again in ${wait} seconds.`,
    };
  }
  await Promise.all([
    kv.put(keyMinute(kind, now), String(use.minute + 1), { expirationTtl: 120 }),
    kv.put(keyDay(kind, now), String(use.day + 1), { expirationTtl: 172800 }),
  ]);
  return { ok: true };
}
