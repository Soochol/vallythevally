import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { useEtfChanges, useEtfFund, useEtfHistory } from "../../api/etf";
import type { EtfChangeRow } from "../../api/generated/EtfChangeRow";
import type { EtfFundSummary } from "../../api/generated/EtfFundSummary";
import type { EtfHolding } from "../../api/generated/EtfHolding";
import { ApiRequestError } from "../../api/http";
import { useSendSymbol } from "../pages/sendSymbol";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { panelDomId, tabDomId } from "../ui/Tabs";
import { rovingIndex } from "../ui/roving";
import { AccumulationTab } from "./AccumulationTab";
import { CumulativeCurve } from "./CumulativeCurve";
import { Failure, Loading, Notice } from "./EtfStates";
import { HelpTip } from "./HelpTip";
import { HistoryTab } from "./HistoryTab";
import { HoldingsTable } from "./HoldingsTable";
import { type OverlapPair, OverlapTab } from "./OverlapTab";
import { ReverseTab } from "./ReverseTab";
import { SimilarTab } from "./SimilarTab";
import { Treemap } from "./Treemap";
import {
  BASKET_LIMIT,
  type HoldingsBreadth,
  type TabId,
  type TreemapLens,
  formatPercent,
  formatRealChange,
  holdingsBreadth,
  isGlobalTab,
  maAlignedCount,
  rankHoldings,
} from "./etfModel";

export type { TabId } from "./etfModel";

const GLOBAL_TABS = [
  { id: "accumulation", label: "동시 매집" },
  { id: "overlap", label: "겹침" },
  { id: "reverse", label: "역추적" },
] as const;

const FUND_TABS = [
  { id: "holdings", label: "구성" },
  { id: "history", label: "편입 변경" },
  { id: "similar", label: "유사 ETF" },
] as const;

export const TABS = [...GLOBAL_TABS, ...FUND_TABS] as const;

export const tabOf = (value: string | null): TabId => TABS.find((tab) => tab.id === value)?.id ?? "holdings";

const LENS_OPTIONS: readonly SegmentedOption<TreemapLens>[] = [
  { value: "weight", label: "비중 강도" },
  { value: "ma", label: "이평선 추세" },
  { value: "flow", label: "최근 매집" },
];

function ScopeBar({
  tab,
  fund,
  basketCount,
  onTab,
}: {
  tab: TabId;
  fund: EtfFundSummary | null;
  basketCount: number;
  onTab: (tab: TabId) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const ordered = TABS;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") return;
    const buttons = Array.from(bar.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const current = buttons.findIndex((node) => node === document.activeElement);
    const target = rovingIndex(ordered.length, Math.max(0, current), event.key);
    if (target === null) return;
    event.preventDefault();
    buttons[target]?.focus();
    onTab(ordered[target]!.id);
  };

  return (
    <div className="etf-scope-bar">
      <div ref={bar} role="tablist" aria-label="ETF 상세" className="etf-scope-tabs" onKeyDown={onKeyDown}>
        <div role="presentation" className="etf-scope-group" data-zone="global">
          {GLOBAL_TABS.map((item) => {
            const selected = item.id === tab;
            return (
              <button
                key={item.id}
                id={tabDomId("etf", item.id)}
                type="button"
                role="tab"
                className="etf-scope-tab"
                aria-selected={selected}
                aria-controls={panelDomId("etf", item.id)}
                aria-label={item.label}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTab(item.id)}
              >
                <span>{item.label}</span>
                {item.id === "overlap" && (
                  <span className="etf-scope-tag" aria-hidden="true">
                    {basketCount}/{BASKET_LIMIT}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <span className="etf-scope-divider" aria-hidden="true" />
        <div role="presentation" className="etf-scope-group" data-zone="fund">
          {FUND_TABS.map((item) => {
            const selected = item.id === tab;
            return (
              <button
                key={item.id}
                id={tabDomId("etf", item.id)}
                type="button"
                role="tab"
                className="etf-scope-tab"
                aria-selected={selected}
                aria-controls={panelDomId("etf", item.id)}
                aria-label={item.label}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTab(item.id)}
              >
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      {fund !== null && (
        <span className="etf-scope-fund" title={fund.name}>
          {fund.name}
        </span>
      )}
    </div>
  );
}

function SummaryCells({ fund, breadth }: { fund: EtfFundSummary; breadth: HoldingsBreadth | null }) {
  const cells = [
    ["종목 수", `${fund.holdingsCount}개`, null],
    ["상위 5 비중", formatPercent(fund.top5WeightBps), null],
    [
      "실효 종목 수",
      fund.effectiveHoldings.toFixed(1),
      "비중이 같은 종목 몇 개와 맞먹는지 나타냅니다. 1 ÷ Σ(비중²)이며 작을수록 몇몇 종목에 몰려 있습니다.",
    ],
    ["구성 기준일", fund.status.holdingsAsOf, null],
  ] as const;
  const hasBreadth = breadth !== null && breadth.evaluated > 0;
  return (
    <dl className="etf-summary" aria-label="요약 지표">
      {cells.map(([label, value, help]) => (
        <div key={label} className="etf-summary-cell">
          <dt>
            {label}
            {help !== null && <HelpTip label={`${label} 설명`} text={help} />}
          </dt>
          <dd>{value}</dd>
        </div>
      ))}
      <div className="etf-summary-cell">
        <dt>
          이평선 건전성
          <HelpTip label="이평선 건전성 설명" text="20일 이동평균선 상회 비중과 20·60·120일선 정배열(3▲) 비중입니다." />
        </dt>
        <dd>{hasBreadth ? `${breadth.above20Pct}%` : "-"}</dd>
        {hasBreadth && (
          <dd className="etf-summary-sub">
            <span>20일↑ · 정배열 {breadth.aligned3Pct}%</span>
            <span className="etf-summary-bar" aria-hidden="true">
              <i style={{ width: `${breadth.above20Pct}%` }} />
            </span>
          </dd>
        )}
      </div>
    </dl>
  );
}

function LensInfoBar({
  lens,
  hovered,
  changeRow,
  hasChanges,
}: {
  lens: TreemapLens;
  hovered: EtfHolding | null;
  changeRow: EtfChangeRow | undefined;
  hasChanges: boolean;
}) {
  if (hovered !== null) {
    const aligned = maAlignedCount(hovered.ma);
    const changeLabel =
      changeRow === undefined
        ? null
        : changeRow.kind === "added"
          ? "신규 편입"
          : changeRow.kind === "removed"
            ? "편출"
            : changeRow.realChange === null
              ? "유지"
              : formatRealChange(changeRow.realChange);
    return (
      <div className="etf-lens-bar" data-hover="true" role="status">
        <span className="etf-lens-focus-name">{hovered.name}</span>
        <span className="etf-row-code">{hovered.code}</span>
        <span className="etf-lens-focus-stat">비중 {formatPercent(hovered.weightBps)}</span>
        <span className="etf-lens-focus-stat">이평 정배열 {aligned}/3</span>
        {changeLabel !== null && <span className="etf-lens-focus-stat">최근 {changeLabel}</span>}
      </div>
    );
  }
  if (lens === "ma") {
    return (
      <div className="etf-lens-bar">
        <span className="etf-lens-swatch" data-swatch="up">3▲ 정배열</span>
        <span className="etf-lens-swatch" data-swatch="warn">혼조</span>
        <span className="etf-lens-swatch" data-swatch="down">하회</span>
        <span className="etf-lens-swatch" data-swatch="none">자료 없음</span>
      </div>
    );
  }
  if (lens === "flow") {
    return (
      <div className="etf-lens-bar">
        {hasChanges ? (
          <>
            <span className="etf-lens-swatch" data-swatch="accent">편입</span>
            <span className="etf-lens-swatch" data-swatch="up">늘림</span>
            <span className="etf-lens-swatch" data-swatch="down">줄임</span>
            <span className="etf-lens-swatch" data-swatch="none">유지</span>
          </>
        ) : (
          <span className="etf-lens-note">최근 수집된 편입 변경 이력이 아직 없습니다</span>
        )}
      </div>
    );
  }
  return (
    <div className="etf-lens-bar">
      <span className="etf-lens-note">칸 면적과 밝기가 종목 비중을 나타냅니다 · 올리면 곡선과 표가 함께 강조됩니다</span>
    </div>
  );
}

function HoldingsTab({ code, onOpenReverse }: { code: string; onOpenReverse: (stockCode: string) => void }) {
  const [lens, setLens] = useState<TreemapLens>("weight");
  const [hoveredCode, setHoveredCode] = useState<string | null>(null);
  const detail = useEtfFund(code);
  const history = useEtfHistory(code);
  const latestPair = history.data?.pairs[0] ?? null;
  const changes = useEtfChanges(code, latestPair);
  const send = useSendSymbol();
  const pick = (holding: EtfHolding) => send({ code: holding.code, name: holding.name });

  const changesByCode = useMemo(() => {
    const map = new Map<string, EtfChangeRow>();
    for (const row of changes.data?.rows ?? []) map.set(row.code, row);
    return map;
  }, [changes.data]);

  const holdings = detail.data?.holdings ?? [];
  const ranked = useMemo(() => rankHoldings(holdings), [holdings]);

  if (detail.isPending) return <Loading label="구성을 불러오는 중입니다" />;
  if (detail.isError) {
    const missing = detail.error instanceof ApiRequestError && detail.error.code === "not_found";
    return missing ? (
      <Notice title="찾을 수 없는 ETF입니다" role="alert" />
    ) : (
      <Failure what="구성" retry={() => void detail.refetch()} />
    );
  }

  const hovered = hoveredCode === null ? null : holdings.find((item) => item.code === hoveredCode) ?? null;

  return (
    <>
      <section className="etf-card" aria-label="트리맵">
        <div className="etf-card-head">
          <h3>전 종목 트리맵</h3>
          <Segmented
            label="트리맵 렌즈"
            mode="pressed"
            size="sm"
            className="etf-lens-seg"
            options={LENS_OPTIONS}
            value={lens}
            onChange={(next) => setLens(next)}
          />
        </div>
        <LensInfoBar
          lens={lens}
          hovered={hovered}
          changeRow={hovered === null ? undefined : changesByCode.get(hovered.code)}
          hasChanges={changesByCode.size > 0}
        />
        <Treemap
          holdings={holdings}
          lens={lens}
          changesByCode={changesByCode}
          hoveredCode={hoveredCode}
          onHover={setHoveredCode}
          onPick={pick}
        />
      </section>
      <section className="etf-card" aria-label="누적 비중">
        <h3>누적 비중 곡선</h3>
        <CumulativeCurve curve={ranked} hoveredCode={hoveredCode} />
      </section>
      <section className="etf-card etf-card-wide" aria-label="구성 표">
        <h3>구성 표</h3>
        <HoldingsTable
          ranked={ranked}
          changesByCode={changesByCode}
          hoveredCode={hoveredCode}
          onHover={setHoveredCode}
          onPick={pick}
          onReverseStock={onOpenReverse}
        />
      </section>
    </>
  );
}

interface EtfDetailProps {
  fund: EtfFundSummary | null;
  funds: readonly EtfFundSummary[];
  tab: TabId;
  basket: readonly string[];
  basketNotice: string | null;
  stock: string | null;
  pair: string | null;
  overlapPair: OverlapPair | null;
  onPair: (after: string) => void;
  onTab: (tab: TabId) => void;
  onToggleBasket: (code: string) => void;
  onStock: (code: string | null) => void;
  onOpenFund: (code: string) => void;
  onOpenReverse: (stockCode: string) => void;
  onComparePair: (codeA: string, codeB: string) => void;
}

function Panel({
  fund,
  funds,
  tab,
  basket,
  stock,
  pair,
  overlapPair,
  onPair,
  onToggleBasket,
  onStock,
  onOpenFund,
  onOpenReverse,
  onComparePair,
}: EtfDetailProps) {
  if (tab === "overlap") {
    return (
      <OverlapTab
        basket={basket}
        funds={funds}
        initialPair={overlapPair}
        onRemove={onToggleBasket}
        onOpenReverse={onOpenReverse}
      />
    );
  }
  if (tab === "reverse") {
    return (
      <ReverseTab
        stock={stock}
        basket={basket}
        onStock={onStock}
        onOpenFund={onOpenFund}
        onToggleBasket={onToggleBasket}
      />
    );
  }
  if (tab === "accumulation") {
    return <AccumulationTab onOpenFund={onOpenFund} onOpenReverse={onOpenReverse} />;
  }
  if (tab === "holdings" && fund) return <HoldingsTab key={fund.code} code={fund.code} onOpenReverse={onOpenReverse} />;
  if (tab === "history" && fund) {
    return <HistoryTab key={fund.code} code={fund.code} pair={pair} onPair={onPair} onOpenReverse={onOpenReverse} />;
  }
  if (tab === "similar" && fund) {
    return (
      <SimilarTab
        key={fund.code}
        code={fund.code}
        fundName={fund.name}
        onOpenFund={onOpenFund}
        onComparePair={onComparePair}
      />
    );
  }
  return <Notice title="ETF를 고르세요">왼쪽 목록에서 ETF를 고르세요</Notice>;
}

export function EtfDetail(props: EtfDetailProps) {
  const { fund, tab, basket, basketNotice, onTab, onToggleBasket } = props;
  const send = useSendSymbol();
  const showFundHero = !isGlobalTab(tab) && fund !== null;
  const fundDetail = useEtfFund(showFundHero ? fund.code : null);
  const breadth = useMemo(
    () => (fundDetail.data ? holdingsBreadth(fundDetail.data.holdings) : null),
    [fundDetail.data],
  );
  const inBasket = fund !== null && basket.includes(fund.code);

  return (
    <section className="etf-detail" aria-label={showFundHero ? `${fund.name} 상세` : "ETF 상세"}>
      <ScopeBar tab={tab} fund={fund} basketCount={basket.length} onTab={onTab} />
      {basketNotice !== null && (
        <div className="etf-basket-notice etf-detail-basket-notice" role="alert">
          {basketNotice}
        </div>
      )}
      {showFundHero && (
        <>
          <header className="etf-hero">
            <div className="etf-hero-copy">
              <h2>{fund.name}</h2>
              <div className="etf-chips">
                <span>{fund.code}</span>
                <span>{fund.style === "active" ? "액티브" : "패시브"}</span>
                <span>{fund.issuer}</span>
                {fund.benchmark !== "" && <span>{fund.benchmark}</span>}
              </div>
            </div>
            <div className="etf-hero-actions">
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={inBasket}
                onClick={() => onToggleBasket(fund.code)}
              >
                {inBasket ? "비교 담김" : "+ 비교 담기"}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => send({ code: fund.code, name: fund.name })}
              >
                ETF 차트
              </button>
            </div>
          </header>
          <SummaryCells fund={fund} breadth={breadth} />
        </>
      )}
      <div role="tabpanel" id={panelDomId("etf", tab)} aria-labelledby={tabDomId("etf", tab)} className="etf-panel">
        <Panel {...props} />
      </div>
    </section>
  );
}
