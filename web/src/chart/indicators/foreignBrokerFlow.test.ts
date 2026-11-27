import { describe, expect, it } from "vitest";
import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import { buildForeignBrokerSeries, resolveForeignNetQty, top5ForeignNetQty } from "./foreignBrokerFlow";

const mkSnap = (t: number, foreignEstNetQty?: number): FeedBrokers => ({
  t,
  buys: [
    { code: "036", name: "모건스탠리", qty: 5000, qtyChange: 100 },
    { code: "001", name: "키움증권", qty: 8000, qtyChange: 200 },
  ],
  sells: [
    { code: "042", name: "UBS", qty: 1200, qtyChange: 50 },
    { code: "002", name: "미래에셋", qty: 3000, qtyChange: 100 },
  ],
  foreignEstNetQty,
});

describe("foreignBrokerFlow", () => {
  it("sums foreign brokers from 0F top-5 and prefers FID 267 in auto/fid261 mode", () => {
    const snap = mkSnap(1795737900, 12500);
    expect(top5ForeignNetQty(snap)).toBe(3800);
    expect(resolveForeignNetQty(snap, "top5")).toBe(3800);
    expect(resolveForeignNetQty(snap, "fid261")).toBe(12500);
    expect(resolveForeignNetQty(snap, "auto")).toBe(12500);
    expect(resolveForeignNetQty(mkSnap(1795737900), "auto")).toBe(3800);
  });

  it("buckets snapshots and computes per-bucket delta", () => {
    const t1 = Math.floor(Date.parse("2026-11-27T09:05:10+09:00") / 1000);
    const t2 = Math.floor(Date.parse("2026-11-27T09:06:10+09:00") / 1000);
    const series = buildForeignBrokerSeries([mkSnap(t1, 1000), mkSnap(t2, 2600)], "1m", "auto");
    expect(series).toHaveLength(2);
    expect(series[0]!.cumNetQty).toBe(1000);
    expect(series[0]!.deltaQty).toBe(1000);
    expect(series[1]!.cumNetQty).toBe(2600);
    expect(series[1]!.deltaQty).toBe(1600);
  });
});
