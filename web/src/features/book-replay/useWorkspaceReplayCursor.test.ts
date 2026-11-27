import { describe, expect, test } from "vitest";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { barInterval } from "../../chart/crosshairSync";
import { resolveWorkspaceReplayCursor } from "./useWorkspaceReplayCursor";

const CODE = "005930" as SymbolCode;
const OTHER = "000660" as SymbolCode;
const TODAY_MIDNIGHT = Date.UTC(2026, 10, 22, 15, 0, 0) / 1000;
const DAY_SECONDS = 86_400;
const at = (hour: number, minute: number, second = 0) => TODAY_MIDNIGHT + hour * 3600 + minute * 60 + second;

describe("resolveWorkspaceReplayCursor", () => {
  test("returns live when disabled, unpointed, or pointing to another symbol", () => {
    const bar = barInterval(at(9, 0), "5m");
    const now = at(14, 0);

    expect(resolveWorkspaceReplayCursor(false, CODE, { symbol: CODE, bar, close: 71_000 }, now)).toEqual({ kind: "live" });
    expect(resolveWorkspaceReplayCursor(true, CODE, null, now)).toEqual({ kind: "live" });
    expect(resolveWorkspaceReplayCursor(true, CODE, { symbol: OTHER, bar, close: 190_000 }, now)).toEqual({ kind: "live" });
  });

  test("returns in_progress when now is before bar.end", () => {
    const bar = barInterval(at(9, 30), "5m");
    const result = resolveWorkspaceReplayCursor(true, CODE, { symbol: CODE, bar, close: 71_500 }, at(9, 34, 59));
    expect(result).toEqual({ kind: "in_progress", bar, date: "20261123" });
  });

  test("returns pointed with isToday=true for a completed bar today", () => {
    const bar = barInterval(at(9, 0), "5m");
    const result = resolveWorkspaceReplayCursor(true, CODE, { symbol: CODE, bar, close: 71_200 }, at(9, 5, 0));
    expect(result).toEqual({
      kind: "pointed",
      symbol: CODE,
      bar,
      date: "20261123",
      at: at(9, 4, 59),
      secondOfDay: 9 * 3600 + 4 * 60 + 59,
      minute: 9 * 60 + 4,
      isToday: true,
      close: 71_200,
    });
  });

  test("returns pointed with isToday=false for a bar from a previous day", () => {
    const prevStart = at(9, 0) - DAY_SECONDS;
    const bar = barInterval(prevStart, "5m");
    const result = resolveWorkspaceReplayCursor(true, CODE, { symbol: CODE, bar, close: null }, at(14, 0));
    expect(result).toEqual({
      kind: "pointed",
      symbol: CODE,
      bar,
      date: "20261122",
      at: prevStart + 5 * 60 - 1,
      secondOfDay: 9 * 3600 + 4 * 60 + 59,
      minute: 9 * 60 + 4,
      isToday: false,
      close: null,
    });
  });
});
