import { describe, expect, test } from "vitest";
import type { BookReplayTrades } from "../../api/generated/BookReplayTrades";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { barInterval } from "../../chart/crosshairSync";
import { REPLAY_REASON } from "./replay";
import { projectTradesReplay } from "./tradesReplay";
import type { WorkspaceReplayCursor } from "./useWorkspaceReplayCursor";

const CODE = "005930" as SymbolCode;
const DATE = "20261123";
const MIDNIGHT = Date.UTC(2026, 10, 22, 15, 0, 0) / 1000;
const unixAt = (hour: number, minute: number, second = 0) => MIDNIGHT + hour * 3600 + minute * 60 + second;
const secAt = (hour: number, minute: number, second = 0) => hour * 3600 + minute * 60 + second;

const POINTED: WorkspaceReplayCursor = {
  kind: "pointed",
  symbol: CODE,
  bar: barInterval(unixAt(9, 10), "5m"),
  date: DATE,
  at: unixAt(9, 14, 59),
  secondOfDay: secAt(9, 14, 59),
  minute: 9 * 60 + 14,
  isToday: true,
  close: 71_500,
};

const SAMPLE_DATA: BookReplayTrades = {
  symbol: CODE,
  date: DATE,
  coverage: "collected",
  venue: "combined",
  gaps: [[unixAt(9, 5, 0), unixAt(9, 9, 0)]],
  cumVolume: 4_500,
  cumBuyQty: 3_000,
  cumSellQty: 1_500,
  strength: 200,
  trades: [
    { secondOfDay: secAt(9, 12, 10), price: 71_500, quantity: 20, side: "buy", venue: "krx" },
    { secondOfDay: secAt(9, 10, 5), price: 71_400, quantity: 15, side: "sell", venue: "nxt" },
    { secondOfDay: secAt(9, 4, 50), price: 71_200, quantity: 10, side: "buy", venue: "krx" },
  ],
};

describe("projectTradesReplay", () => {
  test("handles live, in_progress, pending, error, coverage, and gap states", () => {
    expect(projectTradesReplay({ kind: "live" }, { data: undefined, isPending: false, isError: false })).toEqual({ kind: "live" });

    expect(
      projectTradesReplay(
        { kind: "in_progress", bar: barInterval(unixAt(9, 30), "5m"), date: DATE },
        { data: undefined, isPending: false, isError: false },
      ),
    ).toEqual({ kind: "none", reason: REPLAY_REASON.inProgress });

    expect(projectTradesReplay(POINTED, { data: undefined, isPending: true, isError: false })).toEqual({
      kind: "none",
      reason: REPLAY_REASON.loading,
    });

    expect(projectTradesReplay(POINTED, { data: undefined, isPending: false, isError: true })).toEqual({
      kind: "none",
      reason: REPLAY_REASON.failed,
    });

    expect(
      projectTradesReplay(POINTED, { data: { ...SAMPLE_DATA, coverage: "day_not_collected", trades: [] }, isPending: false, isError: false }),
    ).toEqual({ kind: "none", reason: REPLAY_REASON.dayNotCollected });

    expect(
      projectTradesReplay(POINTED, { data: { ...SAMPLE_DATA, coverage: "symbol_not_collected", trades: [] }, isPending: false, isError: false }),
    ).toEqual({ kind: "none", reason: REPLAY_REASON.symbolNotCollected });

    const gapCursor: WorkspaceReplayCursor = {
      ...POINTED,
      bar: barInterval(unixAt(9, 5), "5m"),
      at: unixAt(9, 7, 59),
      secondOfDay: secAt(9, 7, 59),
      minute: 9 * 60 + 7,
    };
    expect(projectTradesReplay(gapCursor, { data: SAMPLE_DATA, isPending: false, isError: false })).toEqual({
      kind: "none",
      reason: REPLAY_REASON.gap,
    });
  });

  test("maps trade rows and inserts GapRow between consecutive trades spanning a gap", () => {
    const view = projectTradesReplay(POINTED, { data: SAMPLE_DATA, isPending: false, isError: false });
    if (view.kind !== "past") throw new Error(`expected past, got ${view.kind}`);

    expect(view.at).toBe(POINTED.at);
    expect(view.venue).toBe("combined");
    expect(view.cumVolume).toBe(4_500);
    expect(view.strength).toBe(200);
    expect(view.entries.map((entry) => (entry.kind === "gap" ? ["gap", entry.fromSecond, entry.toSecond] : ["trade", entry.secondOfDay, entry.price, entry.side, entry.origin]))).toEqual([
      ["trade", secAt(9, 12, 10), 71_500, "buy", "history"],
      ["trade", secAt(9, 10, 5), 71_400, "sell", "history"],
      ["gap", secAt(9, 5, 0), secAt(9, 9, 0)],
      ["trade", secAt(9, 4, 50), 71_200, "buy", "history"],
    ]);
  });

  test("places gap after newest trade at the top, keeps 1s-skewed gap between trades, and skips older gaps", () => {
    const cursor: WorkspaceReplayCursor = {
      ...POINTED,
      bar: barInterval(unixAt(9, 0), "5m"),
      at: unixAt(9, 4, 59),
      secondOfDay: secAt(9, 4, 59),
      minute: 9 * 60 + 4,
    };
    const postNewestData: BookReplayTrades = {
      ...SAMPLE_DATA,
      gaps: [[unixAt(9, 2, 0), unixAt(9, 4, 0)]],
      trades: [{ secondOfDay: secAt(9, 1, 0), price: 71_000, quantity: 10, side: "buy", venue: "krx" }],
    };
    const postNewestView = projectTradesReplay(cursor, { data: postNewestData, isPending: false, isError: false });
    if (postNewestView.kind !== "past") throw new Error(`expected past, got ${postNewestView.kind}`);
    expect(postNewestView.entries.map((entry) => (entry.kind === "gap" ? ["gap", entry.fromSecond, entry.toSecond] : ["trade", entry.secondOfDay]))).toEqual([
      ["gap", secAt(9, 2, 0), secAt(9, 4, 0)],
      ["trade", secAt(9, 1, 0)],
    ]);

    const skewedData: BookReplayTrades = {
      ...SAMPLE_DATA,
      gaps: [
        [unixAt(9, 1, 0), unixAt(9, 3, 0)],
        [unixAt(8, 50, 0), unixAt(8, 55, 0)],
      ],
      trades: [
        { secondOfDay: secAt(9, 2, 59), price: 71_200, quantity: 15, side: "sell", venue: "krx" },
        { secondOfDay: secAt(9, 0, 50), price: 71_000, quantity: 10, side: "buy", venue: "krx" },
      ],
    };
    const skewedView = projectTradesReplay(cursor, { data: skewedData, isPending: false, isError: false });
    if (skewedView.kind !== "past") throw new Error(`expected past, got ${skewedView.kind}`);
    expect(skewedView.entries.map((entry) => (entry.kind === "gap" ? ["gap", entry.fromSecond, entry.toSecond] : ["trade", entry.secondOfDay]))).toEqual([
      ["trade", secAt(9, 2, 59)],
      ["gap", secAt(9, 1, 0), secAt(9, 3, 0)],
      ["trade", secAt(9, 0, 50)],
    ]);
  });
});
