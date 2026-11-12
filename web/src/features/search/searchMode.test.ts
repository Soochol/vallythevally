import { expect, test } from "vitest";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import type { SearchCommand } from "../commands/registry";
import { matchingCommands, matchesMarket, searchMode } from "./searchMode";

const commands: SearchCommand[] = [
  { id: "indicator", label: "지표 추가", run: () => {} },
  { id: "screener", label: "스크리너 실행", keywords: "조건식 screener", run: () => {} },
];

test(">로 시작할 때만 명령 모드이며 공백·영문을 정규화한다", () => {
  expect(searchMode("  > 지표 추 가 ")).toEqual({ kind: "commands", query: "지표추가" });
  expect(searchMode(">  ")).toEqual({ kind: "commands", query: "" });
  expect(searchMode("ㅅㅅ")).toEqual({ kind: "symbols", query: "ㅅㅅ" });
  expect(searchMode("naver")).toEqual({ kind: "symbols", query: "NAVER" });
});

test("명령 이름·초성·별칭을 찾고 빈 명령어는 전체를 보인다", () => {
  expect(matchingCommands(commands, "ㅈㅍ").map((c) => c.id)).toEqual(["indicator"]);
  expect(matchingCommands(commands, "SCREENER").map((c) => c.id)).toEqual(["screener"]);
  expect(matchingCommands(commands, "조건식").map((c) => c.id)).toEqual(["screener"]);
  expect(matchingCommands(commands, "없음")).toEqual([]);
  expect(matchingCommands(commands, "")).toEqual(commands);
});

test("시장 필터와 ETF 종류를 구분한다", () => {
  const stock: SymbolInfo = { code: "005930", name: "삼성전자", kind: "common", market: "kospi", nxtEnabled: true };
  expect(matchesMarket(stock, "all")).toBe(true);
  expect(matchesMarket(stock, "kospi")).toBe(true);
  expect(matchesMarket(stock, "kosdaq")).toBe(false);
  expect(matchesMarket(stock, "etf")).toBe(false);
  expect(matchesMarket({ ...stock, kind: "etf" }, "etf")).toBe(true);
});
