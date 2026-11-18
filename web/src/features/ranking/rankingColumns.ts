import type { Ranking } from "../../api/generated/Ranking";
import type { RankingFigures } from "../../api/generated/RankingFigures";
import type { RankingRow } from "../../api/generated/RankingRow";
import {
  type Cell,
  DASH,
  eokCell,
  percentCell,
  placesGained,
  priceCell,
  rateCell,
  sharesCell,
  signedEokCell,
  signedSharesCell,
  signedWonCell,
} from "./rankingFormat";

export interface Column {
  key: string;
  label: string;
  cell(row: RankingRow): Cell;
}

type FiguresOf<K extends RankingFigures["kind"]> = Extract<RankingFigures, { kind: K }>;

function figure<K extends RankingFigures["kind"]>(kind: K, key: string, label: string, cell: (figures: FiguresOf<K>) => Cell): Column {
  return { key, label, cell: (row) => (row.figures.kind === kind ? cell(row.figures as FiguresOf<K>) : DASH) };
}

const PRICE: Column = { key: "price", label: "현재가", cell: (row) => priceCell(row.price) };
const RATE: Column = { key: "changeRate", label: "등락률", cell: (row) => rateCell(row.changeRate) };

const NET_AMOUNTS = [
  figure("netAmounts", "net", "순매수", (f) => signedEokCell(f.net)),
  figure("netAmounts", "buy", "매수", (f) => eokCell(f.buy)),
  figure("netAmounts", "sell", "매도", (f) => eokCell(f.sell)),
];
const NET_QUANTITIES = [
  figure("netQuantities", "net", "순매수", (f) => signedSharesCell(f.net)),
  figure("netQuantities", "buy", "매수", (f) => sharesCell(f.buy)),
  figure("netQuantities", "sell", "매도", (f) => sharesCell(f.sell)),
];

export function columnsFor(ranking: Ranking): readonly Column[] {
  switch (ranking.kind) {
    case "tradeAmount":
      return [PRICE, RATE, figure("tradeAmount", "tradeAmount", "거래대금", (f) => eokCell(f.tradeAmount)), figure("tradeAmount", "volume", "거래량", (f) => sharesCell(f.volume))];
    case "tradeVolume":
      return [
        PRICE,
        RATE,
        figure("tradeVolume", "volume", "거래량", (f) => sharesCell(f.volume)),
        figure("tradeVolume", "previousDayVolumeRate", "전일비", (f) => (f.previousDayVolumeRate === null ? DASH : percentCell(f.previousDayVolumeRate))),
      ];
    case "turnover":
      return [PRICE, RATE, figure("turnover", "turnoverRate", "회전율", (f) => percentCell(f.turnoverRate)), figure("turnover", "volume", "거래량", (f) => sharesCell(f.volume))];
    case "volumeSurge":
      return [
        PRICE,
        RATE,
        figure("volumeSurge", "surgeRate", "급증률", (f) => percentCell(f.surgeRate)),
        figure("volumeSurge", "surgeVolume", "급증량", (f) => sharesCell(f.surgeVolume)),
        figure("volumeSurge", "volume", "현재 거래량", (f) => sharesCell(f.volume)),
      ];
    case "gainers":
    case "losers":
      return [PRICE, RATE, figure("movers", "priceChange", "전일대비", (f) => signedWonCell(f.priceChange)), figure("movers", "volume", "거래량", (f) => sharesCell(f.volume))];
    case "expected":
      return [
        figure("expected", "expectedPrice", "예상체결가", (f) => priceCell(f.expectedPrice)),
        figure("expected", "expectedChangeRate", "예상 등락률", (f) => rateCell(f.expectedChangeRate)),
        figure("expected", "expectedVolume", "예상체결량", (f) => sharesCell(f.expectedVolume)),
      ];
    case "investorNetBuy":
      return [PRICE, RATE, ...(ranking.unit === "quantity" ? NET_QUANTITIES : NET_AMOUNTS)];
    case "foreignStreak":
      return [
        PRICE,
        figure("foreignStreak", "netD1", "D-1(주)", (f) => signedSharesCell(f.netD1)),
        figure("foreignStreak", "netD2", "D-2(주)", (f) => signedSharesCell(f.netD2)),
        figure("foreignStreak", "netD3", "D-3(주)", (f) => signedSharesCell(f.netD3)),
        figure("foreignStreak", "netTotal", "합계(주)", (f) => signedSharesCell(f.netTotal)),
        figure("foreignStreak", "limitExhaustionRate", "한도소진율", (f) => percentCell(f.limitExhaustionRate)),
      ];
    case "program":
      return [PRICE, RATE, ...NET_AMOUNTS];
    case "bidAskBalance":
      return [
        PRICE,
        figure("bidAskBalance", "totalSellRemaining", "총매도잔량", (f) => sharesCell(f.totalSellRemaining)),
        figure("bidAskBalance", "totalBuyRemaining", "총매수잔량", (f) => sharesCell(f.totalBuyRemaining)),
        figure("bidAskBalance", "netBuyRemaining", "순매수잔량", (f) => signedSharesCell(f.netBuyRemaining)),
        figure("bidAskBalance", "buyRatio", "매수비율", (f) => percentCell(f.buyRatio)),
      ];
    case "creditRatio":
      return [PRICE, RATE, figure("creditRatio", "creditRatio", "신용비율", (f) => percentCell(f.creditRatio)), figure("creditRatio", "volume", "거래량", (f) => sharesCell(f.volume))];
    case "mostViewed":
      return [
        figure("mostViewed", "referencePrice", "기준 시점 가격", (f) => priceCell(f.referencePrice)),
        figure("mostViewed", "changeFromReferenceRate", "기준가 대비", (f) => rateCell(f.changeFromReferenceRate)),
      ];
  }
}

export function placesOf(row: RankingRow): Cell | null {
  const { figures } = row;
  return figures.kind === "tradeAmount" || figures.kind === "mostViewed" ? placesGained(figures.placesGained) : null;
}
