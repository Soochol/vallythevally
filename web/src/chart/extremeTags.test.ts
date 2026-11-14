import { expect, test } from "vitest";
import { extremeChange } from "./extremeTags";

test("현재가 대비는 현재가에서 최고가·최저가까지의 등락률이다", () => {
  expect(extremeChange(60_000, 50_000, "last")).toBe("+20.00%");
  expect(extremeChange(40_000, 50_000, "last")).toBe("−20.00%");
});

test("고가·저가 대비는 최고가·최저가에서 현재가까지의 등락률이다", () => {
  expect(extremeChange(60_000, 50_000, "extreme")).toBe("−16.67%");
  expect(extremeChange(40_000, 50_000, "extreme")).toBe("+25.00%");
});

test("나누는 값이 0이면 등락률을 적지 않는다", () => {
  expect(extremeChange(60_000, 0, "last")).toBeNull();
  expect(extremeChange(0, 50_000, "extreme")).toBeNull();
  expect(extremeChange(0, 50_000, "last")).toBe("−100.00%");
});
