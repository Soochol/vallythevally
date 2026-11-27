import { describe, expect, it } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import { computeBarVolumeProfile, fromServerVolumeProfile } from "./volumeProfile";

const mkBar = (t: number, o: number, h: number, l: number, c: number, v: number): Bar => ({ t, o, h, l, c, v });

describe("volumeProfile", () => {
  it("computes POC and 70% Value Area from bars", () => {
    const bars: Bar[] = [
      mkBar(100, 1000, 1020, 990, 1010, 100),
      mkBar(160, 1010, 1030, 1000, 1020, 500),
      mkBar(220, 1020, 1100, 1020, 1090, 80),
    ];
    const vp = computeBarVolumeProfile(bars, 16, 70);
    expect(vp.bins).toHaveLength(16);
    expect(vp.pocPrice).not.toBeNull();
    expect(vp.vahPrice).not.toBeNull();
    expect(vp.valPrice).not.toBeNull();
    expect(vp.vahPrice!).toBeGreaterThanOrEqual(vp.pocPrice!);
    expect(vp.valPrice!).toBeLessThanOrEqual(vp.pocPrice!);
    expect(vp.totalVol).toBeCloseTo(680);
  });

  it("maps server VolumeProfilePage to view result", () => {
    const res = fromServerVolumeProfile({
      symbol: "005930",
      state: "ready",
      bins: [
        { price: 70000, buyVol: 60, sellVol: 40, totalVol: 100 },
        { price: 70100, buyVol: 180, sellVol: 120, totalVol: 300 },
      ],
      pocPrice: 70100,
      vahPrice: 70100,
      valPrice: 70000,
    });
    expect(res.pocPrice).toBe(70100);
    expect(res.maxBinVol).toBe(300);
    expect(res.totalVol).toBe(400);
  });
});
