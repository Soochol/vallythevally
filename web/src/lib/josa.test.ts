import { expect, test } from "vitest";
import { endsWithFinalConsonant, toward } from "./josa";

test("'로'와 '으로'는 받침을 보고 고르고, ㄹ 받침에는 '로'를 쓴다", () => {
  expect(["삼성전자", "LG화학", "카카오뱅크", "셀트리온", "000270", "000660", "005931", "SK", "KODEX 200", "NAVER", "SPY(ETF)"].map(toward)).toEqual([
    "삼성전자로", "LG화학으로", "카카오뱅크로", "셀트리온으로", "000270으로", "000660으로", "005931로", "SK로", "KODEX 200으로", "NAVER로", "SPY(ETF)로",
  ]);
  expect(["종가", "거래량", "철", "1"].map(endsWithFinalConsonant)).toEqual([false, true, true, true]);
});
