import type { FeedTrade } from "../../api/generated/FeedTrade";
import type { Period } from "../../api/generated/Period";
import type { TapeVelocityPoint } from "../../api/generated/TapeVelocityPoint";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { bucketStartSec } from "./microFamily";

export type TapeVelocityMetric = "tps" | "turnover" | "buyRatio";

const PERIOD_SECONDS: Readonly<Partial<Record<Period, number>>> = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "10m": 600,
  "15m": 900,
  "30m": 1800,
  "60m": 3600,
};

export interface LiveTapeBucket {
  readonly t: UnixSeconds;
  tickCount: number;
  turnoverMillionWon: number;
  buyVol: number;
  sellVol: number;
  strength: number | null;
}

export function applyLiveTradeToTape(
  buckets: Map<UnixSeconds, LiveTapeBucket>,
  points: Map<UnixSeconds, TapeVelocityPoint>,
  tick: FeedTrade,
  period: Period,
): TapeVelocityPoint | null {
  const bucketT = bucketStartSec(tick.t, period);
  const periodSec = PERIOD_SECONDS[period];
  if (bucketT === null || periodSec === undefined || tick.price <= 0 || tick.qty === 0) return null;
  let bucket = buckets.get(bucketT);
  if (!bucket) {
    const existing = points.get(bucketT);
    bucket = {
      t: bucketT,
      tickCount: existing ? Math.round(existing.tps * periodSec) : 0,
      turnoverMillionWon: existing ? existing.turnoverMillionWon : 0,
      buyVol: 0,
      sellVol: 0,
      strength: existing?.strength ?? null,
    };
    buckets.set(bucketT, bucket);
  }
  const absQty = Math.abs(tick.qty);
  bucket.tickCount += 1;
  bucket.turnoverMillionWon += (tick.price * absQty) / 1_000_000;
  if (tick.qty > 0) bucket.buyVol += absQty;
  else bucket.sellVol += absQty;
  if (tick.strength !== null && Number.isFinite(tick.strength)) {
    bucket.strength = tick.strength;
  }
  const totalVol = bucket.buyVol + bucket.sellVol;
  const buyRatioPct = totalVol > 0 ? (bucket.buyVol / totalVol) * 100 : 50;
  const next: TapeVelocityPoint = {
    t: bucketT,
    tps: bucket.tickCount / periodSec,
    turnoverMillionWon: bucket.turnoverMillionWon,
    buyRatioPct,
    strength: bucket.strength ?? undefined,
  };
  points.set(bucketT, next);
  return next;
}

export function tapeMetricValue(point: TapeVelocityPoint, metric: TapeVelocityMetric): number {
  switch (metric) {
    case "tps":
      return point.tps;
    case "turnover":
      return point.turnoverMillionWon;
    case "buyRatio":
      return point.buyRatioPct;
  }
}
