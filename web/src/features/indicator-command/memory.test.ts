import { beforeEach, expect, test } from "vitest";
import type { IndicatorConfig } from "../../chart/settings";
import { windowId } from "../../layout/kinds";
import { clearIndicatorMemory, forgetRemembered, rememberedOf, rememberRemoved } from "./memory";

const CELL = windowId("cell-a");
const OTHER = windowId("cell-b");
const ma = (id: string, period: number): IndicatorConfig => ({ id, spec: { kind: "ma", method: "sma", period }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } });
const RSI: IndicatorConfig = { id: "r", spec: { kind: "rsi", period: 7, signal: null }, panel: "p", visible: false, style: { colors: ["ind-2"], width: 2 } };

beforeEach(clearIndicatorMemory);

test("지운 지표는 칸과 종류별로 기억하고 다른 칸에는 보이지 않는다", () => {
  rememberRemoved(CELL, [ma("a", 5), RSI, ma("b", 20)]);
  expect(rememberedOf(CELL, "ma").map((item) => item.id)).toEqual(["a", "b"]);
  expect(rememberedOf(CELL, "rsi")).toEqual([RSI]);
  expect(rememberedOf(OTHER, "ma")).toEqual([]);
});

test("같은 종류를 다시 지우면 마지막에 지운 것으로 바꾸고, 잊으면 비운다", () => {
  rememberRemoved(CELL, [ma("a", 5)]);
  rememberRemoved(CELL, [ma("c", 60)]);
  expect(rememberedOf(CELL, "ma").map((item) => item.id)).toEqual(["c"]);
  forgetRemembered(CELL, "ma");
  expect(rememberedOf(CELL, "ma")).toEqual([]);
});

test("기억한 설정은 원본을 고쳐도 바뀌지 않는다", () => {
  const original = ma("a", 5);
  rememberRemoved(CELL, [original]);
  original.visible = false;
  expect(rememberedOf(CELL, "ma")[0]?.visible).toBe(true);
});
