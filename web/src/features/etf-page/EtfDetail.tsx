import { useEtfFund } from "../../api/etf";
import { ApiRequestError } from "../../api/http";
import type { EtfFundSummary } from "../../api/generated/EtfFundSummary";
import type { EtfHolding } from "../../api/generated/EtfHolding";
import { useSendSymbol } from "../pages/sendSymbol";
import { Tabs, panelDomId, tabDomId } from "../ui/Tabs";
import { Failure, Loading, Notice } from "./EtfStates";
import { HelpTip } from "./HelpTip";
import { CumulativeCurve } from "./CumulativeCurve";
import { HistoryTab } from "./HistoryTab";
import { HoldingsTable } from "./HoldingsTable";
import { Treemap } from "./Treemap";
import { OverlapTab } from "./OverlapTab";
import { ReverseTab } from "./ReverseTab";
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
    ["종목 수", `${fund.holdingsCount}개`, null],
    ["상위 5 비중", formatPercent(fund.top5WeightBps), null],
    ["실효 종목 수", fund.effectiveHoldings.toFixed(1), "비중이 같은 종목 몇 개와 맞먹는지 나타냅니다. 1 ÷ Σ(비중²)이며 작을수록 몇몇 종목에 몰려 있습니다."],
    ["구성 기준일", fund.status.holdingsAsOf, null],
  ] as const;
  return (
    <dl className="etf-summary" aria-label="요약 지표">
      {cells.map(([label, value, help]) => (
        <div key={label} className="etf-summary-cell">
          <dt>{label}{help !== null && <HelpTip label={`${label} 설명`} text={help} />}</dt>
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
  if (detail.isPending) return <Loading label="구성을 불러오는 중입니다" />;
  if (detail.isError) {
    const missing = detail.error instanceof ApiRequestError && detail.error.code === "not_found";
    return missing ? <Notice title="찾을 수 없는 ETF입니다" role="alert" /> : <Failure what="구성" retry={() => void detail.refetch()} />;
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
  fund: EtfFundSummary | null;
  funds: readonly EtfFundSummary[];
  tab: TabId;
  basket: readonly string[];
  stock: string | null;
  pair: string | null;
  onPair: (after: string) => void;
  onTab: (tab: TabId) => void;
  onRemoveFromBasket: (code: string) => void;
  onStock: (code: string | null) => void;
  onOpenFund: (code: string) => void;
}

function Panel({ fund, funds, tab, basket, stock, pair, onPair, onRemoveFromBasket, onStock, onOpenFund }: EtfDetailProps) {
  if (tab === "overlap") return <OverlapTab basket={basket} funds={funds} onRemove={onRemoveFromBasket} />;
  if (tab === "reverse") return <ReverseTab stock={stock} onStock={onStock} onOpenFund={onOpenFund} />;
  if (tab === "holdings" && fund) return <HoldingsTab code={fund.code} />;
  if (tab === "history" && fund) return <HistoryTab code={fund.code} pair={pair} onPair={onPair} />;
  return <Notice title="준비 중입니다" />;
}

export function EtfDetail(props: EtfDetailProps) {
  const { fund, tab, onTab } = props;
  return (
    <section className="etf-detail" aria-label={fund ? `${fund.name} 상세` : "ETF 상세"}>
      {fund && (
        <>
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
        </>
      )}
      <Tabs label="ETF 상세" idPrefix="etf" className="etf-tabs" items={TABS} value={tab} onChange={(id) => onTab(tabOf(id))} />
      <div role="tabpanel" id={panelDomId("etf", tab)} aria-labelledby={tabDomId("etf", tab)} className="etf-panel">
        <Panel {...props} />
      </div>
    </section>
  );
}
