import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import type { Period } from "../../api/generated/Period";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { bucketStartSec } from "./microFamily";

export type ForeignBrokerSource = "auto" | "fid261" | "top5";

const FOREIGN_BROKER_KEYWORDS = [
  "모건", "JP모간", "골드만", "메릴", "UBS", "씨티", "CLSA", "HSBC",
  "노무라", "맥쿼리", "다이와", "도이치", "BNP", "SG", "제프리스",
  "바클레이", "크레디트", "CS", "홍콩상하이", "미즈호", "스탠다드",
];

export function isForeignBrokerName(name: string): boolean {
  const upper = name.toUpperCase();
  return FOREIGN_BROKER_KEYWORDS.some((kw) => upper.includes(kw.toUpperCase()));
}

export function top5ForeignNetQty(snapshot: FeedBrokers): number {
  let buy = 0;
  let sell = 0;
  for (const b of snapshot.buys) {
    if (isForeignBrokerName(b.name)) buy += b.qty;
  }
  for (const s of snapshot.sells) {
    if (isForeignBrokerName(s.name)) sell += s.qty;
  }
  return buy - sell;
}

export function resolveForeignNetQty(snapshot: FeedBrokers, source: ForeignBrokerSource): number {
  if (source === "fid261") return snapshot.foreignEstNetQty ?? 0;
  if (source === "top5") return top5ForeignNetQty(snapshot);
  if (snapshot.foreignEstNetQty !== undefined && Number.isFinite(snapshot.foreignEstNetQty)) {
    return snapshot.foreignEstNetQty;
  }
  return top5ForeignNetQty(snapshot);
}

export interface ForeignBrokerPoint {
  readonly t: UnixSeconds;
  readonly cumNetQty: number;
  readonly deltaQty: number;
}

export function buildForeignBrokerSeries(
  snapshots: readonly FeedBrokers[],
  period: Period,
  source: ForeignBrokerSource,
): ForeignBrokerPoint[] {
  const byBucket = new Map<UnixSeconds, number>();
  for (const snap of snapshots) {
    const bt = bucketStartSec(snap.t, period);
    if (bt === null) continue;
    byBucket.set(bt, resolveForeignNetQty(snap, source));
  }
  const sorted = [...byBucket.entries()].sort((a, b) => a[0] - b[0]);
  let prev = 0;
  return sorted.map(([t, cumNetQty]) => {
    const deltaQty = cumNetQty - prev;
    prev = cumNetQty;
    return { t, cumNetQty, deltaQty };
  });
}
