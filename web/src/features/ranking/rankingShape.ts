import type { BalanceSort } from "../../api/generated/BalanceSort";
import type { ExpectedSort } from "../../api/generated/ExpectedSort";
import type { Market } from "../../api/generated/Market";
import type { MinTradeAmount } from "../../api/generated/MinTradeAmount";
import type { NetDirection } from "../../api/generated/NetDirection";
import type { Ranking } from "../../api/generated/Ranking";
import type { RankingInvestor } from "../../api/generated/RankingInvestor";
import type { RankingMarket } from "../../api/generated/RankingMarket";
import type { SurgeBaseline } from "../../api/generated/SurgeBaseline";
import type { SurgeSort } from "../../api/generated/SurgeSort";
import type { TradeUnit } from "../../api/generated/TradeUnit";
import type { TradingSession } from "../../api/generated/TradingSession";
import type { Venue } from "../../api/generated/Venue";
import type { ViewSpan } from "../../api/generated/ViewSpan";
import type { RankingKind } from "./rankingKinds";

type Check = (value: unknown) => boolean;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isBoolean: Check = (x) => typeof x === "boolean";
const oneOf =
  (allowed: Readonly<Record<string, true>>): Check =>
  (x) =>
    typeof x === "string" && Object.hasOwn(allowed, x);

const rankingMarket = oneOf({ all: true, kospi: true, kosdaq: true } satisfies Record<RankingMarket, true>);
const market = oneOf({ kospi: true, kosdaq: true } satisfies Record<Market, true>);
const venue = oneOf({ combined: true, krx: true, nxt: true } satisfies Record<Venue, true>);
const session = oneOf({ all: true, regular: true, preMarket: true, afterHours: true } satisfies Record<TradingSession, true>);
const baseline = oneOf({ previousDay: true, minutes1: true, minutes5: true, minutes10: true } satisfies Record<SurgeBaseline, true>);
const surgeSort = oneOf({ surgeVolume: true, surgeRate: true, dropRate: true } satisfies Record<SurgeSort, true>);
const minTradeAmount = oneOf({ any: true, atLeast100Million: true, atLeast1Billion: true, atLeast10Billion: true } satisfies Record<MinTradeAmount, true>);
const expectedSort = oneOf({ gainers: true, losers: true } satisfies Record<ExpectedSort, true>);
const investor = oneOf({
  foreign: true,
  foreignFirm: true,
  financialInvestment: true,
  investmentTrust: true,
  otherFinancial: true,
  bank: true,
  insurance: true,
  pensionFund: true,
  state: true,
  otherCorporation: true,
  institution: true,
} satisfies Record<RankingInvestor, true>);
const direction = oneOf({ netBuy: true, netSell: true } satisfies Record<NetDirection, true>);
const unit = oneOf({ amount: true, quantity: true } satisfies Record<TradeUnit, true>);
const balanceSort = oneOf({ netBuyRemaining: true, netSellRemaining: true, buyRatio: true, sellRatio: true } satisfies Record<BalanceSort, true>);
const span = oneOf({ seconds30: true, minute1: true, minutes10: true, hour1: true, today: true } satisfies Record<ViewSpan, true>);
const excludes: Check = (x) => isRecord(x) && isBoolean(x.etfEtn) && isBoolean(x.preferred);

type FieldChecks<K extends RankingKind> = { [F in Exclude<keyof Extract<Ranking, { kind: K }>, "kind">]-?: Check };

const SHAPE: { [K in RankingKind]: FieldChecks<K> } = {
  tradeAmount: { market: rankingMarket, venue, excludes, excludeManaged: isBoolean },
  tradeVolume: { market: rankingMarket, venue, session, excludes, excludeManaged: isBoolean },
  turnover: { market: rankingMarket, venue, excludes, excludeManaged: isBoolean },
  volumeSurge: { market: rankingMarket, venue, baseline, sort: surgeSort, excludes, excludeManaged: isBoolean },
  gainers: { market: rankingMarket, venue, includeLimit: isBoolean, minTradeAmount, excludes, excludeManaged: isBoolean },
  losers: { market: rankingMarket, venue, includeLimit: isBoolean, minTradeAmount, excludes, excludeManaged: isBoolean },
  expected: { market: rankingMarket, venue, sort: expectedSort, excludes, excludeManaged: isBoolean },
  investorNetBuy: { market: rankingMarket, investor, direction, unit, excludes },
  foreignStreak: { market: rankingMarket, venue, direction, excludes },
  program: { market, venue, direction, excludes },
  bidAskBalance: { market, venue, sort: balanceSort, excludes, excludeManaged: isBoolean },
  creditRatio: { market: rankingMarket, venue, excludes, excludeManaged: isBoolean },
  mostViewed: { span, excludes },
};

export function isRanking(x: unknown): x is Ranking {
  if (!isRecord(x) || typeof x.kind !== "string" || !Object.hasOwn(SHAPE, x.kind)) return false;
  const checks: Record<string, Check> = SHAPE[x.kind as RankingKind];
  return Object.entries(checks).every(([field, check]) => check(x[field]));
}
