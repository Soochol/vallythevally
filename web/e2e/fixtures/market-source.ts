import type { FeedBrokerStatus } from "../../src/api/generated/FeedBrokerStatus";
import type { MarketFeature } from "../../src/api/generated/MarketFeature";
import type { MarketSourceStatus } from "../../src/api/generated/MarketSourceStatus";
import type { OverviewFeature } from "../../src/api/generated/OverviewFeature";
import type { RankingChoicesView } from "../../src/api/generated/RankingChoicesView";
import type { RankingKind } from "../../src/api/generated/RankingKind";
import type { RankingKindChoices } from "../../src/api/generated/RankingKindChoices";

export const ALL_RANKING_KINDS: RankingKind[] = ["tradeAmount", "tradeVolume", "turnover", "volumeSurge", "gainers", "losers", "expected", "investorNetBuy", "foreignStreak", "program", "bidAskBalance", "creditRatio", "mostViewed"];
export const KIS_RANKING_KINDS: RankingKind[] = ALL_RANKING_KINDS.filter((kind) => kind !== "foreignStreak" && kind !== "program");
export const ALL_OVERVIEW_FEATURES: OverviewFeature[] = ["index", "sectors", "flow", "intradayFlow", "turnover", "streaks", "stockInvestors", "foreignHoldings", "stockProgramDaily"];
export const KIS_OVERVIEW_FEATURES: OverviewFeature[] = ALL_OVERVIEW_FEATURES.filter((feature) => feature !== "streaks" && feature !== "stockProgramDaily");
export const MARKET_FEATURES: MarketFeature[] = ["directory", "fundamentals", "quotes", "dayBars", "weekBars", "monthBars", "yearBars", "minuteBars", "indexBars", "orderBook", "trades", "programTrades"];

const NO_CHOICES: RankingChoicesView = { venues: [], sessions: [], baselines: [], surgeSorts: [], minTradeAmounts: [], investors: [], spans: [], excludesManaged: false };
const KIWOOM_CHOICES: RankingChoicesView = {
  venues: ["combined", "krx", "nxt"],
  sessions: ["all", "regular", "preMarket", "afterHours"],
  baselines: ["previousDay", "minutes1", "minutes5", "minutes10"],
  surgeSorts: ["surgeVolume", "surgeRate", "dropRate"],
  minTradeAmounts: ["any", "atLeast100Million", "atLeast1Billion", "atLeast10Billion"],
  investors: ["foreign", "foreignFirm", "financialInvestment", "investmentTrust", "otherFinancial", "bank", "insurance", "pensionFund", "state", "otherCorporation", "institution"],
  spans: ["seconds30", "minute1", "minutes10", "hour1", "today"],
  excludesManaged: true,
};

const KIS_VENUES: RankingChoicesView["venues"] = ["combined", "krx", "nxt"];
const kisChoices = (kind: RankingKind): RankingChoicesView => {
  switch (kind) {
    case "tradeAmount":
    case "turnover":
    case "bidAskBalance":
      return { ...NO_CHOICES, venues: KIS_VENUES, excludesManaged: true };
    case "tradeVolume":
      return { ...NO_CHOICES, venues: KIS_VENUES, sessions: ["all", "regular", "afterHours"], excludesManaged: true };
    case "volumeSurge":
      return { ...NO_CHOICES, venues: KIS_VENUES, baselines: ["previousDay"], surgeSorts: ["surgeRate"], excludesManaged: true };
    case "gainers":
    case "losers":
      return { ...NO_CHOICES, venues: KIS_VENUES, minTradeAmounts: KIWOOM_CHOICES.minTradeAmounts, excludesManaged: true };
    case "expected":
    case "creditRatio":
      return { ...NO_CHOICES, venues: ["combined", "krx"] };
    case "investorNetBuy":
      return { ...NO_CHOICES, investors: ["foreign", "institution", "otherCorporation"] };
    case "mostViewed":
      return { ...NO_CHOICES, spans: ["today"] };
    case "foreignStreak":
    case "program":
      return NO_CHOICES;
  }
};

const choicesOf = (kinds: RankingKind[], of: (kind: RankingKind) => RankingChoicesView): RankingKindChoices[] => kinds.map((kind) => ({ kind, choices: of(kind) }));

export const KIWOOM_FEED: FeedBrokerStatus = { broker: "kiwoom", rankingKinds: ALL_RANKING_KINDS, rankingChoices: choicesOf(ALL_RANKING_KINDS, () => KIWOOM_CHOICES), overviewFeatures: ALL_OVERVIEW_FEATURES };
export const KIS_FEED: FeedBrokerStatus = { broker: "kis", rankingKinds: KIS_RANKING_KINDS, rankingChoices: choicesOf(KIS_RANKING_KINDS, kisChoices), overviewFeatures: KIS_OVERVIEW_FEATURES };

export const KIWOOM_MARKET_SOURCE: MarketSourceStatus = { broker: "kiwoom", keyId: "k1", alias: "키 1", state: "connected", problem: null, step: null, retryAt: null, features: MARKET_FEATURES, feedBroker: KIWOOM_FEED };
export const KIS_MARKET_SOURCE: MarketSourceStatus = { broker: "kis", keyId: "kis1", alias: "한투 1", state: "connected", problem: null, step: null, retryAt: null, features: MARKET_FEATURES, feedBroker: KIS_FEED };
export const KIS_SOURCE_KIWOOM_FEED: MarketSourceStatus = { ...KIS_MARKET_SOURCE, feedBroker: KIWOOM_FEED };
