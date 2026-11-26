import { expect, test } from "vitest";
import { ALL_PAGES, pageOfPath, pathOfPage } from "./pages";

test("주소가 페이지로 풀리고 끝의 빗금과 query는 무시한다", () => {
  expect(pageOfPath("/")).toBe("workspace");
  expect(pageOfPath("/home")).toBe("home");
  expect(pageOfPath("/market")).toBe("market");
  expect(pageOfPath("/heatmap/")).toBe("heatmap");
  expect(pageOfPath("/etf")).toBe("etf");
  expect(pageOfPath("/replay")).toBe("replay");
});

test("모르는 주소와 수집기 주소는 페이지가 아니다", () => {
  expect(pageOfPath("/collector")).toBeNull();
  expect(pageOfPath("/market/x")).toBeNull();
  expect(pageOfPath("/nope")).toBeNull();
});

test("모든 페이지는 자기 주소로 돌아온다", () => {
  for (const page of ALL_PAGES) expect(pageOfPath(pathOfPage(page.id))).toBe(page.id);
});
