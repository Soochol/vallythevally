import { useSearchParams } from "react-router";
import type { Market } from "../../api/generated/Market";
import type { MarketOverviewPeriod } from "../../api/generated/MarketOverviewPeriod";
import type { MarketOverviewPhase } from "../../api/generated/MarketOverviewPhase";
import { MARKET_REFRESH_MS, useMarketIndex } from "../../api/marketOverview";
import { useFeedLink } from "../../stores/kiwoomLink";
import { DataAgeNote } from "../data-age/DataAgeNote";
import { formatClock } from "../market-window/format";
import { EmptyState } from "../overlay/State";
import { openSystemSettings } from "../system-settings/open";
import { Segmented } from "../ui/Segmented";
import { PageFrame } from "../pages/PageFrame";
import { FlowCard } from "./FlowCard";
import { IndexCard } from "./IndexCard";
import { SectorCard } from "./SectorCard";
import { StockTabs } from "./StockTabs";
import { TurnoverCard } from "./TurnoverCard";
import "./marketPage.css";

export const MARKETS = [
  { id: "kospi", label: "코스피" },
  { id: "kosdaq", label: "코스닥" },
] as const satisfies readonly { id: Market; label: string }[];
export const PERIODS = ["5", "20", "60"] as const satisfies readonly MarketOverviewPeriod[];
const DEFAULT_MARKET: Market = "kospi";
const DEFAULT_PERIOD: MarketOverviewPeriod = "20";

const PHASE_LABEL: Record<MarketOverviewPhase, string> = { closed: "장 마감", preMarket: "장전", regular: "정규장", afterMarket: "시간외" };

export const marketOf = (value: string | null): Market => (value === "kosdaq" ? "kosdaq" : DEFAULT_MARKET);
export const periodOf = (value: string | null): MarketOverviewPeriod => (value === "5" || value === "60" ? value : DEFAULT_PERIOD);

function Freshness({ market, enabled }: { market: Market; enabled: boolean }) {
  const query = useMarketIndex(market, { enabled });
  const card = query.data;
  if (card === undefined) return <span>{query.isError ? "받지 못함" : "자료를 기다립니다"}</span>;
  const { phase, receivedAt } = card.context;
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
  const market = marketOf(params.get("market"));
  const period = periodOf(params.get("period"));
  const change = (next: { market?: Market; period?: MarketOverviewPeriod }) => {
    const query = new URLSearchParams(params);
    query.set("market", next.market ?? market);
    query.set("period", next.period ?? period);
    setParams(query, { replace: true });
  };
  const indexQuery = useMarketIndex(market, { enabled: connected });
  const card = indexQuery.data;
  const controls = (
    <div className="mk-controls">
      <Segmented label="시장" mode="pressed" value={market} options={MARKETS.map((entry) => ({ value: entry.id, label: entry.label }))} onChange={(next) => change({ market: next })} />
      <Segmented label="기간" mode="pressed" value={period} options={PERIODS.map((id) => ({ value: id, label: `${id}일` }))} onChange={(next) => change({ period: next })} />
    </div>
  );
  return (
    <PageFrame title="시장 종합" freshness={connected ? <Freshness market={market} enabled={connected} /> : null} fresh={connected ? { receivedAt: card?.context.receivedAt ?? null, live: card === undefined ? undefined : card.context.phase !== "closed", failed: card === undefined && indexQuery.isError } : undefined} actions={controls}>
      {!connected ? (
        <div className="mk-before-connect"><EmptyState title="키움 연결 전입니다" action="시스템 설정 열기" onAction={() => openSystemSettings("kiwoom")}>{link?.message && <p>{link.message}</p>}</EmptyState></div>
      ) : (
        <div className="mk-grid">
          <IndexCard market={market} enabled={connected} />
          <FlowCard market={market} period={period} enabled={connected} />
          <SectorCard market={market} enabled={connected} />
          <TurnoverCard market={market} period={period} enabled={connected} />
          <StockTabs market={market} enabled={connected} />
        </div>
      )}
    </PageFrame>
  );
}
