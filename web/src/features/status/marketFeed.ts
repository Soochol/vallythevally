import type { Broker } from "../../api/generated/Broker";
import type { MarketFeature } from "../../api/generated/MarketFeature";
import type { MarketSourceStatus } from "../../api/generated/MarketSourceStatus";
import type { OverviewFeature } from "../../api/generated/OverviewFeature";
import type { Ranking } from "../../api/generated/Ranking";
import type { RankingChoicesView } from "../../api/generated/RankingChoicesView";
import { useMarketSource } from "../../stores/kiwoomLink";
import { BROKERS } from "../system-settings/brokers";

export const FEED_CHOICE_TOOLTIP = "한투로 받을 때는 고를 수 없습니다";
export const FEED_UNAVAILABLE_TEXT = "한투로는 받을 수 없습니다. 키움 키를 더하면 보입니다";

export const brokerShortName = (broker: Broker): string => BROKERS[broker].shortName;

export const feedBrokerOf = (source: MarketSourceStatus | null): Broker | null => source?.feedBroker?.broker ?? null;

export function feedMarkOf(source: MarketSourceStatus | null, received: Broker): Broker | null {
  return source !== null && received !== source.broker ? received : null;
}

export const marketFeatureOn = (source: MarketSourceStatus | null, feature: MarketFeature): boolean => source === null || source.features.includes(feature);

export const overviewFeatureOn = (source: MarketSourceStatus | null, feature: OverviewFeature): boolean => {
  const feed = source?.feedBroker;
  return !feed || feed.overviewFeatures.includes(feature);
};

export const rankingKindOn = (source: MarketSourceStatus | null, kind: Ranking["kind"]): boolean => {
  const feed = source?.feedBroker;
  return !feed || feed.rankingKinds.includes(kind);
};

type ChoiceList = Exclude<keyof RankingChoicesView, "excludesManaged">;

const CHOICE_LIST: Readonly<Record<string, ChoiceList>> = Object.freeze({
  venue: "venues",
  session: "sessions",
  baseline: "baselines",
  minTradeAmount: "minTradeAmounts",
  investor: "investors",
  span: "spans",
});

function listFor(ranking: Ranking, field: string): ChoiceList | null {
  if (field === "sort") return ranking.kind === "volumeSurge" ? "surgeSorts" : null;
  return CHOICE_LIST[field] ?? null;
}

export function rankingChoicesFor(source: MarketSourceStatus | null, kind: Ranking["kind"]): RankingChoicesView | null {
  return source?.feedBroker?.rankingChoices.find((entry) => entry.kind === kind)?.choices ?? null;
}

export function acceptedChoices(source: MarketSourceStatus | null, ranking: Ranking, field: string): readonly string[] | null {
  const list = listFor(ranking, field);
  if (list === null) return null;
  const accepted = rankingChoicesFor(source, ranking.kind)?.[list];
  return accepted && accepted.length > 0 ? accepted : null;
}

export const choiceOn = (source: MarketSourceStatus | null, ranking: Ranking, field: string, value: string): boolean => acceptedChoices(source, ranking, field)?.includes(value) ?? true;

const lastSyllable = (text: string): number => text.charCodeAt(text.length - 1) - 0xac00;
const hasFinalConsonant = (text: string): boolean => lastSyllable(text) % 28 !== 0;
const objectParticle = (text: string): string => (hasFinalConsonant(text) ? "을" : "를");
const directionParticle = (text: string): string => (!hasFinalConsonant(text) || lastSyllable(text) % 28 === 8 ? "로" : "으로");

export interface Adapted {
  ranking: Ranking;
  changes: readonly string[];
}

const FIELD_LABEL: Readonly<Record<string, string>> = Object.freeze({ venue: "거래소", session: "장 구분", baseline: "기준 기간", sort: "정렬", minTradeAmount: "거래대금", investor: "투자자", span: "조회 기간" });

export function adaptRanking(source: MarketSourceStatus | null, ranking: Ranking, labelOf: (field: string, value: string) => string): Adapted {
  let next: Record<string, unknown> = ranking;
  const changes: string[] = [];
  for (const field of Object.keys(ranking)) {
    const value = (ranking as Record<string, unknown>)[field];
    const accepted = typeof value === "string" ? acceptedChoices(source, ranking, field) : null;
    if (accepted === null || typeof value !== "string" || accepted.includes(value)) continue;
    const first = accepted[0]!;
    next = { ...next, [field]: first };
    const label = FIELD_LABEL[field] ?? field;
    const shown = labelOf(field, first);
    changes.push(`${label}${objectParticle(label)} ‘${shown}’${directionParticle(shown)} 바꿨습니다`);
  }
  return { ranking: next as Ranking, changes };
}

export const useOverviewOn = (feature: OverviewFeature): boolean => overviewFeatureOn(useMarketSource(), feature);

export const SCREENER_REFRESH_TOOLTIP = "키움 키가 있어야 갱신합니다";

export const useScreenerRefreshNeedsKiwoom = (): boolean => feedBrokerOf(useMarketSource()) === "kis";
