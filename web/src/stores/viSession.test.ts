import { describe, expect, it } from "vitest";
import type { ViPlaybook } from "../api/generated/ViPlaybook";
import type { ViState } from "../api/generated/ViState";
import {
  appendExpectedPoint,
  computeViTiming,
  detectTrapAlert,
  formatCountdown,
  resolveViViewState,
  type ViExpectedPoint,
} from "./viSession";

const activeVi = (patch: Partial<ViState> = {}): ViState => ({
  symbol: "005930",
  market: "krx",
  active: true,
  direction: "up",
  triggerPrice: 77_000,
  base: 70_000,
  triggeredAt: 1_000,
  releasedAt: null,
  ...patch,
});

const emptyPlaybook: ViPlaybook = {
  symbol: "005930",
  direction: "up",
  kind: "all",
  lookbackDays: 20,
  sampleCount: 0,
  horizons: [],
  recentMatches: [],
};

describe("viSession", () => {
  it("computes elapsed and remaining seconds clamped to 0..120", () => {
    expect(computeViTiming(activeVi({ triggeredAt: 1_000 }), 1_045)).toEqual({ elapsedSec: 45, remainingSec: 75 });
    expect(computeViTiming(activeVi({ triggeredAt: 1_000 }), 1_150)).toEqual({ elapsedSec: 150, remainingSec: 0 });
    expect(computeViTiming(activeVi({ triggeredAt: 1_000 }), 990)).toEqual({ elapsedSec: 0, remainingSec: 120 });
    expect(computeViTiming(activeVi({ triggeredAt: null }), 1_045)).toEqual({ elapsedSec: 0, remainingSec: 120 });
  });

  it("formats countdown as MM:SS", () => {
    expect(formatCountdown(120)).toBe("02:00");
    expect(formatCountdown(75)).toBe("01:15");
    expect(formatCountdown(9)).toBe("00:09");
    expect(formatCountdown(-4)).toBe("00:00");
  });

  it("appends expected points only when price or qty changes", () => {
    const s0: readonly ViExpectedPoint[] = [];
    expect(appendExpectedPoint(s0, null, 1_001)).toBe(s0);
    expect(appendExpectedPoint(s0, { price: 0, qty: 100 }, 1_001)).toBe(s0);

    const s1 = appendExpectedPoint(s0, { price: 77_500, qty: 500 }, 1_005);
    expect(s1).toEqual([{ t: 1_005, price: 77_500, qty: 500 }]);

    const s2 = appendExpectedPoint(s1, { price: 77_500, qty: 500 }, 1_010);
    expect(s2).toBe(s1);

    const s3 = appendExpectedPoint(s2, { price: 78_000, qty: 650 }, 1_020);
    expect(s3).toEqual([
      { t: 1_005, price: 77_500, qty: 500 },
      { t: 1_020, price: 78_000, qty: 650 },
    ]);
  });

  it("detects trap alert only in the last 15 seconds on >=0.5% reversal or >=30% volume shrink", () => {
    const upDrop: ViExpectedPoint[] = [
      { t: 1_010, price: 78_000, qty: 1_000 },
      { t: 1_060, price: 80_000, qty: 1_200 },
      { t: 1_110, price: 79_500, qty: 1_200 },
    ];
    expect(detectTrapAlert(upDrop, "up", 104)).toBeNull();
    const alert = detectTrapAlert(upDrop, "up", 105);
    expect(alert?.reason).toBe("price_drop");
    expect(alert!.changePct).toBeCloseTo(-0.625, 3);
    expect(alert?.detectedAt).toBe(1_110);

    const volumeDrop: ViExpectedPoint[] = [
      { t: 1_010, price: 80_000, qty: 1_000 },
      { t: 1_060, price: 80_000, qty: 1_000 },
      { t: 1_112, price: 79_900, qty: 650 },
    ];
    const volAlert = detectTrapAlert(volumeDrop, "up", 112);
    expect(volAlert?.reason).toBe("volume_shrink");
    expect(volAlert!.changePct).toBeCloseTo(-35, 3);

    const downBounce: ViExpectedPoint[] = [
      { t: 1_010, price: 63_000, qty: 500 },
      { t: 1_060, price: 62_000, qty: 600 },
      { t: 1_115, price: 62_400, qty: 600 },
    ];
    const downAlert = detectTrapAlert(downBounce, "down", 115);
    expect(downAlert?.reason).toBe("price_drop");
    expect(downAlert!.changePct).toBeGreaterThanOrEqual(0.5);

    const calm: ViExpectedPoint[] = [
      { t: 1_010, price: 78_000, qty: 1_000 },
      { t: 1_060, price: 78_500, qty: 1_100 },
      { t: 1_115, price: 78_400, qty: 950 },
    ];
    expect(detectTrapAlert(calm, "up", 115)).toBeNull();
  });

  it("returns inactive when vi is null or inactive and active with trapAlert when live", () => {
    expect(resolveViViewState({ vi: null, nowSec: 1_100, expectedSeries: [], playbook: emptyPlaybook })).toEqual({ kind: "inactive" });
    expect(resolveViViewState({ vi: activeVi({ active: false }), nowSec: 1_100, expectedSeries: [], playbook: emptyPlaybook })).toEqual({ kind: "inactive" });

    const series: ViExpectedPoint[] = [
      { t: 1_020, price: 80_000, qty: 1_000 },
      { t: 1_110, price: 79_200, qty: 1_000 },
    ];
    const resolved = resolveViViewState({ vi: activeVi({ triggeredAt: 1_000 }), nowSec: 1_110, expectedSeries: series, playbook: emptyPlaybook });
    expect(resolved.kind).toBe("active");
    if (resolved.kind === "active") {
      expect(resolved.elapsedSec).toBe(110);
      expect(resolved.remainingSec).toBe(10);
      expect(resolved.trapAlert?.reason).toBe("price_drop");
      expect(resolved.playbook).toBe(emptyPlaybook);
    }
  });
});
