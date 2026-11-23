import { expect, test } from "vitest";
import { parseDurationMs } from "./QuoteCells";

test("토큰 길이는 ms와 s 모두 밀리초로 읽는다", () => {
  expect(parseDurationMs("140ms")).toBe(140);
  expect(parseDurationMs(" .14s ")).toBeCloseTo(140);
  expect(parseDurationMs("0.22s")).toBeCloseTo(220);
  expect(parseDurationMs("")).toBe(0);
  expect(parseDurationMs("fast")).toBe(0);
});
