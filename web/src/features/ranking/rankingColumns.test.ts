import { expect, test } from "vitest";
import type { RankingFigures } from "../../api/generated/RankingFigures";
import type { RankingRow } from "../../api/generated/RankingRow";
import { columnsFor, placesOf } from "./rankingColumns";
import { startRanking } from "./rankingChoices";
import { RANKING_KINDS } from "./rankingKinds";

const common = { market: "all", venue: "combined", excludes: { etfEtn: true, preferred: false }, excludeManaged: false } as const;
const row = (figures: RankingFigures, over: Partial<RankingRow> = {}): RankingRow => ({ rank: 1, code: "005930", name: "삼성전자", listed: true, price: 70_000, changeRate: 1.5, figures, ...over });

test("13종 순위 모두 열 정의가 있고 열 키가 겹치지 않는다", () => {
  for (const kind of RANKING_KINDS) {
    const keys = columnsFor(startRanking(kind, common)).map((c) => c.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  }
});

test("순위 종류마다 플랜 표의 열 이름을 그 차례로 보인다", () => {
  const labels = (kind: Parameters<typeof startRanking>[0]) => columnsFor(startRanking(kind, common)).map((c) => c.label);
  expect(labels("tradeAmount")).toEqual(["현재가", "등락률", "거래대금", "거래량"]);
  expect(labels("tradeVolume")).toEqual(["현재가", "등락률", "거래량", "전일비"]);
  expect(labels("turnover")).toEqual(["현재가", "등락률", "회전율", "거래량"]);
  expect(labels("volumeSurge")).toEqual(["현재가", "등락률", "급증률", "급증량", "현재 거래량"]);
  expect(labels("gainers")).toEqual(["현재가", "등락률", "전일대비", "거래량"]);
  expect(labels("losers")).toEqual(labels("gainers"));
  expect(labels("expected")).toEqual(["예상체결가", "예상 등락률", "예상체결량"]);
  expect(labels("investorNetBuy")).toEqual(["현재가", "등락률", "순매수", "매수", "매도"]);
  expect(labels("foreignStreak")).toEqual(["현재가", "D-1(주)", "D-2(주)", "D-3(주)", "합계(주)", "한도소진율"]);
  expect(labels("program")).toEqual(["현재가", "등락률", "순매수", "매수", "매도"]);
  expect(labels("bidAskBalance")).toEqual(["현재가", "총매도잔량", "총매수잔량", "순매수잔량", "매수비율"]);
  expect(labels("creditRatio")).toEqual(["현재가", "등락률", "신용비율", "거래량"]);
  expect(labels("mostViewed")).toEqual(["기준 시점 가격", "기준가 대비"]);
});

test("투자자별 순매수는 단위에 따라 금액은 억, 수량은 주로 보인다", () => {
  const amount = columnsFor({ ...startRanking("investorNetBuy", common), unit: "amount" } as never);
  const quantity = columnsFor({ ...startRanking("investorNetBuy", common), unit: "quantity" } as never);
  const amounts = row({ kind: "netAmounts", net: -250_000_000, buy: 1_000_000_000, sell: 1_250_000_000 });
  const quantities = row({ kind: "netQuantities", net: 12_000, buy: 30_000, sell: 18_000 });
  expect(amount.slice(2).map((c) => c.cell(amounts).text)).toEqual(["−2.50억", "10.00억", "12.50억"]);
  expect(quantity.slice(2).map((c) => c.cell(quantities).text)).toEqual(["+1만주", "3만", "2만"]);
  expect(amount[2]!.cell(amounts).tone).toBe("down");
  expect(quantity[2]!.cell(quantities).tone).toBe("up");
});

test("등락 값은 부호로 up·down을 가르고 값이 없으면 대시다", () => {
  const [price, rate] = columnsFor(startRanking("tradeAmount", common));
  const figures: RankingFigures = { kind: "tradeAmount", tradeAmount: 123_400_000_000, volume: 1_000, placesGained: 3 };
  expect(rate!.cell(row(figures, { changeRate: -2.1 }))).toEqual({ text: "−2.10%", tone: "down" });
  expect(rate!.cell(row(figures, { changeRate: 0 })).tone).toBe("flat");
  expect(rate!.cell(row(figures, { changeRate: null })).text).toBe("—");
  expect(price!.cell(row(figures, { price: null })).text).toBe("—");
  expect(columnsFor(startRanking("tradeAmount", common))[2]!.cell(row(figures)).text).toBe("1,234억");
  expect(columnsFor(startRanking("tradeAmount", common))[2]!.cell(row({ kind: "netAmounts", net: 1, buy: 1, sell: 1 })).text).toBe("—");
});

test("순위 변동은 올랐으면 ▲n, 내렸으면 ▼n, 같으면 –이고 변동이 없는 순위는 보이지 않는다", () => {
  const traded = (placesGained: number | null) => row({ kind: "tradeAmount", tradeAmount: 1, volume: 1, placesGained });
  expect(placesOf(traded(3))).toEqual({ text: "▲3", tone: "up" });
  expect(placesOf(traded(-2))).toEqual({ text: "▼2", tone: "down" });
  expect(placesOf(traded(0))).toEqual({ text: "–", tone: "flat" });
  expect(placesOf(traded(null))).toEqual({ text: "–", tone: "flat" });
  expect(placesOf(row({ kind: "mostViewed", referencePrice: 1, changeFromReferenceRate: 1, placesGained: 5 }))?.text).toBe("▲5");
  expect(placesOf(row({ kind: "turnover", turnoverRate: 1, volume: 1 }))).toBeNull();
});
