import { expect, test } from "vitest";
import type { ViState } from "../../api/generated/ViState";
import { releaseMinuteOpen, viBaseSource, viPricesOf } from "./viPrices";

const MINUTE = 60;
const TEN = 1_794_186_000;
const bar = (t: number, o: number) => ({ t, o, h: o + 10, l: o - 10, c: o + 5, v: 1 });
const state = (patch: Partial<ViState>): ViState => ({ symbol: "005930", active: false, direction: "up", triggerPrice: 881_000, base: null, triggeredAt: TEN, releasedAt: TEN + 134, ...patch });

test("상승VI는 기준가의 1.1배를 호가 단위로 올리고 하락VI는 0.9배를 내린다", () => {
  expect(viPricesOf(800_000, "stock")).toEqual({ up: 880_000, down: 720_000 });
  expect(viPricesOf(69_900, "stock")).toEqual({ up: 76_900, down: 62_900 });
  expect(viPricesOf(18_190, "stock")).toEqual({ up: 20_050, down: 16_370 });
  expect(viPricesOf(1_823, "stock")).toEqual({ up: 2_010, down: 1_640 });
  expect(viPricesOf(10_005, "etf")).toEqual({ up: 11_010, down: 9_000 });
  expect(viPricesOf(70_000, "stock")).toEqual({ up: 77_000, down: 63_000 });
});

test("기준가가 있으면 그 값, 오늘 VI가 없으면 시가, 해제 뒤 비어 있으면 해제 시각의 분봉을 쓴다", () => {
  expect(viBaseSource(state({ base: 884_000 }), true)).toEqual({ kind: "known", price: 884_000 });
  expect(viBaseSource(state({ active: true, base: 800_000, releasedAt: null }), true)).toEqual({ kind: "known", price: 800_000 });
  expect(viBaseSource(state({ triggeredAt: null, releasedAt: null, base: 800_000 }), true)).toEqual({ kind: "known", price: 800_000 });
  expect(viBaseSource(null, true)).toEqual({ kind: "dayOpen" });
  expect(viBaseSource(state({ triggeredAt: null, releasedAt: null }), true)).toEqual({ kind: "dayOpen" });
  expect(viBaseSource(state({}), true)).toEqual({ kind: "releaseMinute", releasedAt: TEN + 134 });
});

test("상태를 모르거나 발동 중 기준가가 없거나 해제 시각을 모르면 기준가를 모른다", () => {
  expect(viBaseSource(null, false)).toEqual({ kind: "unknown" });
  expect(viBaseSource(state({ active: true, releasedAt: null }), true)).toEqual({ kind: "unknown" });
  expect(viBaseSource(state({ releasedAt: null }), true)).toEqual({ kind: "unknown" });
});

test("해제 시각이 든 분의 시가를 쓰고 그 분이 없으면 다음 봉의 시가를 쓴다", () => {
  const releasedAt = TEN + 2 * MINUTE + 14;
  const before = bar(TEN + MINUTE, 70_000);
  const inside = bar(TEN + 2 * MINUTE, 71_000);
  const next = bar(TEN + 4 * MINUTE, 72_000);
  expect(releaseMinuteOpen({ bars: [before, inside, next], current: null }, releasedAt)).toBe(71_000);
  expect(releaseMinuteOpen({ bars: [before, next], current: null }, releasedAt)).toBe(72_000);
  expect(releaseMinuteOpen({ bars: [before], current: inside }, releasedAt)).toBe(71_000);
  expect(releaseMinuteOpen({ bars: [before], current: null }, releasedAt)).toBeNull();
});
