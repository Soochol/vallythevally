import { expect, test } from "vitest";
import type { SaveState } from "./saver";
import { saveIndicator } from "./saveStatus";

const idle: SaveState = { kind: "idle" };
const saved = (at: number): SaveState => ({ kind: "saved", at });
const error: SaveState = { kind: "failed", reason: "error", message: "x" };
const tooLarge: SaveState = { kind: "failed", reason: "too_large" };

test("아무것도 저장하지 않았으면 숨긴다", () => {
  expect(saveIndicator({ layout: idle, ui: idle, watchlist: idle })).toEqual({ kind: "hidden" });
});

test("저장됨은 가장 늦은 시각을 보인다", () => {
  expect(saveIndicator({ layout: saved(5), ui: saved(9), watchlist: idle })).toEqual({ kind: "saved", at: 9 });
});

test("하나라도 기다리거나 보내는 중이면 저장 중이다", () => {
  expect(saveIndicator({ layout: saved(5), ui: { kind: "pending" }, watchlist: idle })).toEqual({ kind: "busy" });
  expect(saveIndicator({ layout: { kind: "saving" }, ui: idle, watchlist: idle })).toEqual({ kind: "busy" });
});

test("실패는 저장 중보다, 너무 큼은 실패보다 앞선다", () => {
  expect(saveIndicator({ layout: { kind: "saving" }, ui: error, watchlist: idle })).toEqual({ kind: "failed" });
  expect(saveIndicator({ layout: tooLarge, ui: error, watchlist: idle })).toEqual({ kind: "tooLarge", hint: "지표나 비교 종목을 줄이세요" });
  expect(saveIndicator({ layout: idle, ui: tooLarge, watchlist: idle })).toEqual({ kind: "tooLarge", hint: null });
});
