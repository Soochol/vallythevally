import { useEtfFund } from "../../api/etf";
import { ApiRequestError } from "../../api/http";
import type { EtfFundSummary } from "../../api/generated/EtfFundSummary";
import type { EtfHolding } from "../../api/generated/EtfHolding";
import { useSendSymbol } from "../pages/sendSymbol";
import { CumulativeCurve } from "./CumulativeCurve";
import { HoldingsTable } from "./HoldingsTable";
import { Treemap } from "./Treemap";
import { formatPercent } from "./etfModel";

export const TABS = [
  { id: "holdings", label: "구성" },
  { id: "overlap", label: "겹침" },
  { id: "history", label: "편입 변경" },
  { id: "reverse", label: "역추적" },
] as const;
export type TabId = (typeof TABS)[number]["id"];

export const tabOf = (value: string | null): TabId => TABS.find((tab) => tab.id === value)?.id ?? "holdings";

function SummaryCells({ fund }: { fund: EtfFundSummary }) {
  const cells = [
    ["종목 수", `${fund.holdingsCount}개`],
    ["상위 5 비중", formatPercent(fund.top5WeightBps)],
    ["실효 종목 수", fund.effectiveHoldings.toFixed(1)],
    ["구성 기준일", fund.status.holdingsAsOf],
  ] as const;
  return (
    <dl className="etf-summary" aria-label="요약 지표">
      {cells.map(([label, value]) => (
        <div key={label} className="etf-summary-cell">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function HoldingsTab({ code }: { code: string }) {
  const detail = useEtfFund(code);
  const send = useSendSymbol();
  const pick = (holding: EtfHolding) => send({ code: holding.code, name: holding.name });
  if (detail.isPending) return <div className="etf-empty" role="status">구성을 불러오는 중입니다</div>;
  if (detail.isError) {
    const missing = detail.error instanceof ApiRequestError && detail.error.code === "not_found";
    return (
      <div className="etf-empty" role="alert">
        {missing ? "찾을 수 없는 ETF입니다" : "구성을 불러오지 못했습니다"}
        {!missing && <button type="button" className="etf-retry" onClick={() => void detail.refetch()}>다시 시도</button>}
      </div>
    );
  }
  const { holdings } = detail.data;
  return (
    <>
      <section className="etf-card" aria-label="트리맵">
        <h3>전 종목 트리맵</h3>
        <Treemap holdings={holdings} onPick={pick} />
      </section>
      <section className="etf-card" aria-label="누적 비중">
        <h3>누적 비중 곡선</h3>
        <CumulativeCurve weightsBps={holdings.map((holding) => holding.weightBps)} />
      </section>
      <section className="etf-card etf-card-wide" aria-label="구성 표">
        <h3>구성 표</h3>
        <HoldingsTable holdings={holdings} onPick={pick} />
      </section>
    </>
  );
}

interface EtfDetailProps {
  fund: EtfFundSummary;
  tab: TabId;
  onTab: (tab: TabId) => void;
}

export function EtfDetail({ fund, tab, onTab }: EtfDetailProps) {
  return (
    <section className="etf-detail" aria-label={`${fund.name} 상세`}>
      <header className="etf-hero">
        <h2>{fund.name}</h2>
        <div className="etf-chips">
          <span>{fund.code}</span>
          <span>{fund.style === "active" ? "액티브" : "패시브"}</span>
          <span>{fund.issuer}</span>
          {fund.benchmark !== "" && <span>{fund.benchmark}</span>}
        </div>
      </header>
      <SummaryCells fund={fund} />
      <div role="tablist" aria-label="ETF 상세" className="etf-tabs">
        {TABS.map((entry) => (
          <button key={entry.id} type="button" role="tab" id={`etf-tab-${entry.id}`} aria-selected={tab === entry.id} aria-controls="etf-panel" onClick={() => onTab(entry.id)}>
            {entry.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="etf-panel" aria-labelledby={`etf-tab-${tab}`} className="etf-panel">
        {tab === "holdings" ? <HoldingsTab code={fund.code} /> : <div className="etf-empty" role="status">준비 중입니다</div>}
      </div>
    </section>
  );
}
