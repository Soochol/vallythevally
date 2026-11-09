import { expect, test } from "vitest";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { searchList } from "./searchList";

const info = (code: string, name: string): SymbolInfo => ({ code, name, kind: "common", market: "kospi", nxtEnabled: false });
const samsung = info("005930", "삼성전자");
const naver = info("035420", "NAVER");
const none = { watch: [], recent: [] };

test("빈 입력이면 관심종목 다음에 최근 본 종목을 고를 수 있다", () => {
  expect(searchList("", { watch: [naver], recent: [samsung, naver] }, undefined)).toEqual({
    rows: [
      { info: naver, group: "watch" },
      { info: samsung, group: "recent" },
      { info: naver, group: "recent" },
    ],
    selectable: true,
    empty: true,
  });
});

test("결과의 검색어가 지금 입력과 같으면 고를 수 있다", () => {
  expect(searchList("NAVER", none, { q: "NAVER", rows: [naver] })).toEqual({
    rows: [{ info: naver, group: "result" }],
    selectable: true,
    empty: false,
  });
});

test("디바운스 중이거나 새 결과를 기다리는 동안 남은 이전 결과는 고를 수 없다", () => {
  expect(searchList("NAVER", none, { q: "삼성전자", rows: [samsung] }).selectable).toBe(false);
});

test("아직 결과가 없으면 빈 목록이다", () => {
  expect(searchList("NAVER", { watch: [samsung], recent: [samsung] }, undefined)).toEqual({ rows: [], selectable: false, empty: false });
});
