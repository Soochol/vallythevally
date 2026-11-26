import { useSearchParams } from "react-router";
import type { Market } from "../../api/generated/Market";
import type { MarketOverviewIndexCard } from "../../api/generated/MarketOverviewIndexCard";
import type { MarketOverviewPeriod } from "../../api/generated/MarketOverviewPeriod";
import type { MarketOverviewPhase } from "../../api/generated/MarketOverviewPhase";
import type { MarketOverviewScope } from "../../api/generated/MarketOverviewScope";
import { MARKET_REFRESH_MS, useMarketIndex } from "../../api/marketOverview";
import { useFeedLink } from "../../stores/kiwoomLink";
import { DataAgeNote } from "../data-age/DataAgeNote";
import { formatClock } from "../market-window/format";
import { EmptyState } from "../overlay/State";
import { PageFrame } from "../pages/PageFrame";
import { useOverviewOn } from "../status/marketFeed";
import { openSystemSettings } from "../system-settings/open";
import { Segmented } from "../ui/Segmented";
import { BreadthXrayCard } from "./BreadthXrayCard";
import { BrokerBookCard } from "./BrokerBookCard";
import { DisclosureRadarCard } from "./DisclosureRadarCard";
import { FlowCard } from "./FlowCard";
import { IndexCard } from "./IndexCard";
import { MaThrustCard } from "./MaThrustCard";
import { PointAttributionCard } from "./PointAttributionCard";
import { RrgQuadrantCard } from "./RrgQuadrantCard";
import { SectorCard } from "./SectorCard";
import { SessionDnaCard } from "./SessionDnaCard";
import { StockTabs } from "./StockTabs";
import { TurnoverCard } from "./TurnoverCard";
import { scopeLabel } from "./derivedFormat";
import "./marketPage.css";

export const SCOPES = [
  { id: "all", label: "전체" },
  { id: "kospi", label: "코스피" },
  { id: "kosdaq", label: "코스닥" },
] as const satisfies readonly { id: MarketOverviewScope; label: string }[];

export const PERIODS = ["5", "20", "60"] as const satisfies readonly MarketOverviewPeriod[];
const DEFAULT_SCOPE: MarketOverviewScope = "all";
const DEFAULT_PERIOD: MarketOverviewPeriod = "20";

const PHASE_LABEL: Record<MarketOverviewPhase, string> = { closed: "장 마감", preMarket: "장전", regular: "정규장", afterMarket: "시간외" };

export function scopeOf(scopeParam: string | null, legacyMarketParam: string | null): MarketOverviewScope {
  if (scopeParam === "all" || scopeParam === "kospi" || scopeParam === "kosdaq") return scopeParam;
  if (legacyMarketParam === "kospi" || legacyMarketParam === "kosdaq") return legacyMarketParam;
  return DEFAULT_SCOPE;
}

export const periodOf = (value: string | null): MarketOverviewPeriod => (value === "5" || value === "60" ? value : DEFAULT_PERIOD);

export const activeMarketOf = (scope: MarketOverviewScope): Market => (scope === "kosdaq" ? "kosdaq" : "kospi");

export interface ResolvedFreshness {
  phase: MarketOverviewPhase | null;
  receivedAt: number | null;
  failed: boolean;
}

export function resolveFreshness(
  scope: MarketOverviewScope,
  kospi: { data: MarketOverviewIndexCard | undefined; isError: boolean },
  kosdaq: { data: MarketOverviewIndexCard | undefined; isError: boolean },
): ResolvedFreshness {
  const candidates = scope === "kospi" ? [kospi] : scope === "kosdaq" ? [kosdaq] : [kospi, kosdaq];
  const cards = candidates
    .map((entry) => entry.data)
    .filter((entry): entry is MarketOverviewIndexCard => entry !== undefined);
  if (cards.length === 0) {
    return {
      phase: null,
      receivedAt: null,
      failed: candidates.every((entry) => entry.isError),
    };
  }
  const latest = cards.reduce((best, current) => {
    const bestAt = best.context.receivedAt ?? Number.NEGATIVE_INFINITY;
    const currentAt = current.context.receivedAt ?? Number.NEGATIVE_INFINITY;
    return currentAt > bestAt ? current : best;
  });
  return {
    phase: latest.context.phase,
    receivedAt: latest.context.receivedAt,
    failed: false,
  };
}

function Freshness({ resolved }: { resolved: ResolvedFreshness }) {
  if (resolved.phase === null) return <span>{resolved.failed ? "받지 못함" : "자료를 기다립니다"}</span>;
  const { phase, receivedAt } = resolved;
  return (
    <>
      <span data-phase={phase}>{PHASE_LABEL[phase]}</span>
      <span>받은 시각 {receivedAt === null ? "—" : formatClock(receivedAt)}</span>
      <DataAgeNote recordedAt={receivedAt} cadence="marketOverview" live={phase !== "closed"} />
      <span>{MARKET_REFRESH_MS / 60_000}분마다 갱신</span>
    </>
  );
}

export function MarketPage() {
  const [params, setParams] = useSearchParams();
  const link = useFeedLink();
  const connected = link === null || link.state === "connected";
  const indexOn = useOverviewOn("index");
  const indexEnabled = connected && indexOn;
  const scope = scopeOf(params.get("scope"), params.get("market"));
  const activeMarket = activeMarketOf(scope);
  const period = periodOf(params.get("period"));
  const change = (next: { scope?: MarketOverviewScope; period?: MarketOverviewPeriod }) => {
    const query = new URLSearchParams(params);
    query.delete("market");
    query.set("scope", next.scope ?? scope);
    query.set("period", next.period ?? period);
    setParams(query, { replace: true });
  };
  const kospiQuery = useMarketIndex("kospi", { enabled: indexEnabled && scope !== "kosdaq" });
  const kosdaqQuery = useMarketIndex("kosdaq", { enabled: indexEnabled && scope !== "kospi" });
  const resolved = resolveFreshness(scope, kospiQuery, kosdaqQuery);
  const controls = (
    <div className="mk-controls">
      <Segmented label="기간" mode="pressed" value={period} options={PERIODS.map((id) => ({ value: id, label: `${id}일` }))} onChange={(next) => change({ period: next })} />
    </div>
  );
  return (
    <PageFrame title="시장 종합" freshness={connected ? <Freshness resolved={resolved} /> : null} fresh={connected ? { receivedAt: resolved.receivedAt, live: resolved.phase === null ? undefined : resolved.phase !== "closed", failed: resolved.failed } : undefined} actions={controls}>
      {!connected ? (
        <div className="mk-before-connect"><EmptyState title="키움 연결 전입니다" action="시스템 설정 열기" onAction={() => openSystemSettings("kiwoom")}>{link?.message && <p>{link.message}</p>}</EmptyState></div>
      ) : (
        <div className="mk-grid">
          <IndexCard scope={scope} onScopeChange={(next) => change({ scope: next })} enabled={connected} />
          <div className="mk-scope-bar" data-scope={scope}>
            <Segmented
              label="시장 범위"
              mode="pressed"
              value={scope}
              options={SCOPES.map((entry) => ({ value: entry.id, label: entry.label }))}
              onChange={(next) => change({ scope: next })}
            />
            <span className="mk-scope-note">
              {scope === "all"
                ? "전체 범위 · 수급·업종·거래대금은 코스피 기준"
                : `${scopeLabel(scope)} 집중 보기 · 같은 지수 카드를 다시 누르면 전체로 돌아갑니다`}
            </span>
          </div>
          <FlowCard market={activeMarket} period={period} enabled={connected} />
          <SectorCard market={activeMarket} enabled={connected} />
          <BreadthXrayCard scope={scope} enabled={connected} />
          <TurnoverCard market={activeMarket} period={period} enabled={connected} />
          <StockTabs scope={scope} market={activeMarket} enabled={connected} />
          <PointAttributionCard scope={scope} enabled={connected} />
          <MaThrustCard scope={scope} enabled={connected} />
          <RrgQuadrantCard scope={scope} enabled={connected} />
          <SessionDnaCard scope={scope} enabled={connected} />
          <BrokerBookCard scope={scope} enabled={connected} />
          <DisclosureRadarCard scope={scope} enabled={connected} />
        </div>
      )}
    </PageFrame>
  );
}
