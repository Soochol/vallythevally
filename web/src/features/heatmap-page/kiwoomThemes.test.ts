import { expect, test } from "vitest";
import type { HeatmapBoardTheme } from "../../api/generated/HeatmapBoardTheme";
import type { KiwoomCatalogInfo } from "../../api/generated/KiwoomCatalogInfo";
import { arrangeThemes, catalogFreshness, catalogNotice, themeTileWeights } from "./kiwoomThemes";

const theme = (id: string, traded: number | null): HeatmapBoardTheme => ({
  id,
  name: id,
  summary: traded === null ? null : { weightedRate: 1, tradedMillionWon: traded, rising: 1, flat: 0, falling: 0, leader: "005930" },
  members: [],
  missing: [],
});

const catalog = (state: KiwoomCatalogInfo["state"], date: string | null = null): KiwoomCatalogInfo => ({ date, collectedAt: null, themes: 0, state });

test("칸 무게는 테마 거래대금 합의 제곱근이고 시세가 없는 테마는 가장 작은 값을 받는다", () => {
  expect(themeTileWeights([theme("a", 9_000_000), theme("b", 1_000_000), theme("c", null)])).toEqual([3_000, 1_000, 1_000]);
});

test("거래대금이 하나도 없으면 모든 테마가 같은 무게다", () => {
  expect(themeTileWeights([theme("a", null), theme("b", 0)])).toEqual([1, 1]);
});

test("아주 작은 테마도 전체 무게의 0.1%는 받아 지도에서 사라지지 않는다", () => {
  const themes = [theme("big", 1_000_000_000_000), theme("tiny", 1)];
  const [big, tiny] = themeTileWeights(themes);
  expect(big).toBe(1_000_000);
  expect(tiny).toBeCloseTo((1_000_000 + 1) * 0.001, 6);
});

test("큰 테마부터 놓아 첫 칸이 가장 크고 등락률 순서와는 상관없다", () => {
  const rects = arrangeThemes([theme("small", 1_000), theme("big", 900_000), theme("mid", 40_000)], 160, 90);
  const area = (id: string) => rects.get(id)!.w * rects.get(id)!.h;
  expect(rects.get("big")).toMatchObject({ x: 0, y: 0 });
  expect(area("big")).toBeGreaterThan(area("mid"));
  expect(area("mid")).toBeGreaterThan(area("small"));
  expect(area("big") / area("small")).toBeCloseTo(30, 4);
});

test("모든 테마가 지도 위에 자리를 받고 넓이는 무게 비율을 따른다", () => {
  const themes = Array.from({ length: 142 }, (_, i) => theme(`kiwoom-${i}`, i % 7 === 0 ? null : (i + 1) * 1_000));
  const rects = arrangeThemes(themes, 160, 90);
  expect(rects.size).toBe(142);
  expect([...rects.values()].reduce((sum, r) => sum + r.w * r.h, 0)).toBeCloseTo(160 * 90, 4);
  expect([...rects.values()].every((r) => r.w > 0 && r.h > 0)).toBe(true);
});

test("받는 중과 비어 있음에만 안내가 있고 준비된 목록에는 없다", () => {
  expect(catalogNotice(catalog("collecting"))).toEqual({ title: "키움 테마 구성종목을 받는 중입니다", hint: null });
  expect(catalogNotice(catalog("empty"))?.hint).toBe("키움이 연결되면 08:30 이후 받습니다");
  expect(catalogNotice(catalog("ready", "2026-11-23"))).toBeNull();
  expect(catalogNotice(null)).toBeNull();
});

test("구성종목 기준일은 받은 날이 있을 때만 말한다", () => {
  expect(catalogFreshness(catalog("ready", "2026-11-23"))).toBe("구성종목 2026-11-23 기준");
  expect(catalogFreshness(catalog("empty"))).toBeNull();
  expect(catalogFreshness(null)).toBeNull();
});
