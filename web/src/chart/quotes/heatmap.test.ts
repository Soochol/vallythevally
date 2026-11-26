import { describe, expect, it, vi } from "vitest";
import type { MicroEvent } from "../../api/generated/MicroEvent";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { drawMicroMarkers, resolveMicroMarkerBarIndex } from "./heatmap";

const eventAt = (sec: number, priceWon = 70_100): MicroEvent => ({
  recvMs: sec * 1000,
  kind: "spoof_cancel",
  side: "ask",
  priceWon,
  cancelledOrAbsorbedQty: 2_000,
  displayedQty: 2_500,
  executedQty: 0,
  ratioBps: 10_000,
});

describe("resolveMicroMarkerBarIndex", () => {
  it("uses periodSec for a single visible 5m bar instead of hardcoding 60s", () => {
    const t0 = Date.parse("2026-11-25T09:00:00+09:00") / 1000;
    const bars = [{ t: t0 as UnixSeconds }];
    expect(resolveMicroMarkerBarIndex(bars, 0, 0, 300, t0 + 180)).toBe(0);
    expect(resolveMicroMarkerBarIndex(bars, 0, 0, 300, t0 + 299)).toBe(0);
    expect(resolveMicroMarkerBarIndex(bars, 0, 0, 300, t0 + 300)).toBe(-1);
  });

  it("does not expand endSec across overnight gaps or pull off-screen events onto the last bar", () => {
    const prevClose = Date.parse("2026-11-24T15:25:00+09:00") / 1000;
    const nextOpen = Date.parse("2026-11-25T09:00:00+09:00") / 1000;
    const bars = [{ t: prevClose as UnixSeconds }, { t: nextOpen as UnixSeconds }];

    expect(resolveMicroMarkerBarIndex(bars, 0, 1, 300, prevClose + 120)).toBe(0);
    expect(resolveMicroMarkerBarIndex(bars, 0, 1, 300, prevClose + 3600)).toBe(-1);
    expect(resolveMicroMarkerBarIndex(bars, 0, 1, 300, nextOpen + 240)).toBe(1);
    expect(resolveMicroMarkerBarIndex(bars, 0, 1, 300, nextOpen + 300)).toBe(-1);
    expect(resolveMicroMarkerBarIndex(bars, 0, 1, 300, nextOpen + 3600)).toBe(-1);
  });
});

describe("drawMicroMarkers", () => {
  it("draws only events inside visible bar period windows", () => {
    const prevClose = Date.parse("2026-11-24T15:25:00+09:00") / 1000;
    const nextOpen = Date.parse("2026-11-25T09:00:00+09:00") / 1000;
    const bars = [{ t: prevClose as UnixSeconds }, { t: nextOpen as UnixSeconds }];
    const arc = vi.fn();
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc,
      fill: vi.fn(),
      stroke: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: () => ({ width: 20 }),
      font: "",
      textBaseline: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
    } as unknown as CanvasRenderingContext2D;

    drawMicroMarkers(ctx, {
      bars,
      from: 0,
      to: 1,
      periodSec: 300,
      events: [
        eventAt(nextOpen + 200),
        eventAt(nextOpen + 600),
        eventAt(prevClose + 1800),
      ],
      showSpoof: true,
      showIceberg: true,
      verbose: false,
      spoofColor: "#ff0000",
      icebergColor: "#00ff00",
      bgColor: "#000000",
      textColor: "#ffffff",
      fontFamily: "sans-serif",
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
      x: (index) => (index + 1) * 100,
      y: () => 50,
    });

    expect(arc).toHaveBeenCalledTimes(1);
    expect(arc.mock.calls[0]![0]).toBe(200);
  });
});
