import { useSearchParams } from "react-router";
import type { Market } from "../../api/generated/Market";
import type { MarketOverviewPeriod } from "../../api/generated/MarketOverviewPeriod";
import type { MarketOverviewPhase } from "../../api/generated/MarketOverviewPhase";
import { MARKET_REFRESH_MS, useMarketIndex } from "../../api/marketOverview";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { formatClock } from "../market-window/format";
import { EmptyState } from "../overlay/State";
import { PageFrame } from "../pages/PageFrame";
import { FlowCard } from "./FlowCard";
import { IndexCard } from "./IndexCard";
import { SectorCard } from "./SectorCard";
import { StockTabs } from "./StockTabs";
import { TurnoverCard } from "./TurnoverCard";
import { formatLevel, signedRate, toneOf } from "./marketFormat";
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
  const card = useMarketIndex(market, { enabled }).data;
  if (card === undefined) return <span>자료를 기다립니다</span>;
  const { phase, receivedAt } = card.context;
  return (
    <>
      <span data-phase={phase}>{PHASE_LABEL[phase]}</span>
      <span>받은 시각 {receivedAt === null ? "—" : formatClock(receivedAt)}</span>
      <span>{MARKET_REFRESH_MS / 60_000}분마다 갱신</span>
    </>
  );
}

function Volatility({ market, enabled }: { market: Market; enabled: boolean }) {
  const card = useMarketIndex(market, { enabled }).data;
  const part = card?.index;
  const volatility = part?.status === "ok" ? part.value.volatility : null;
  if (volatility === null || volatility === undefined) return null;
  return (
    <span className="mk-vkospi" aria-label="VKOSPI">
      VKOSPI <b>{formatLevel(volatility.level)}</b> <span data-tone={toneOf(volatility.changeRate)}>{signedRate(volatility.changeRate)}</span>
    </span>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { id: T; label: string }[]; onChange: (next: T) => void }) {
  return (
    <div role="group" aria-label={label} className="mk-seg">
      {options.map((option) => (
        <button key={option.id} type="button" aria-pressed={value === option.id} onClick={() => onChange(option.id)}>{option.label}</button>
      ))}
    </div>
  );
}

export function MarketPage() {
  const [params, setParams] = useSearchParams();
  const link = useKiwoomLinkStore((s) => s.status);
  const connected = link === null || link.state === "connected";
  const market = marketOf(params.get("market"));
  const period = periodOf(params.get("period"));
  const change = (next: { market?: Market; period?: MarketOverviewPeriod }) => {
    const query = new URLSearchParams(params);
    query.set("market", next.market ?? market);
    query.set("period", next.period ?? period);
    setParams(query, { replace: true });
  };
  const controls = (
    <div className="mk-controls">
      <Volatility market={market} enabled={connected} />
      <Segmented label="시장" value={market} options={MARKETS} onChange={(next) => change({ market: next })} />
      <Segmented label="기간" value={period} options={PERIODS.map((id) => ({ id, label: `${id}일` }))} onChange={(next) => change({ period: next })} />
    </div>
  );
  return (
    <PageFrame title="시장 종합" freshness={connected ? <Freshness market={market} enabled={connected} /> : null} actions={controls}>
      {!connected ? (
        <EmptyState title="키움 연결 전입니다">{link?.message && <p>{link.message}</p>}</EmptyState>
      ) : (
        <div className="mk-grid">
          <div className="mk-span-2"><IndexCard market={market} enabled={connected} /></div>
          <FlowCard market={market} period={period} enabled={connected} />
          <SectorCard market={market} enabled={connected} />
          <TurnoverCard market={market} period={period} enabled={connected} />
          <StockTabs market={market} enabled={connected} />
        </div>
      )}
    </PageFrame>
  );
}
