import { Fragment, type KeyboardEvent, useMemo, useRef, useState } from "react";
import { type EtfAccumulationWindow, useEtfAccumulation } from "../../api/etf";
import type { EtfAccumulationContributor } from "../../api/generated/EtfAccumulationContributor";
import type { EtfAccumulationDirection } from "../../api/generated/EtfAccumulationDirection";
import type { EtfAccumulationRow } from "../../api/generated/EtfAccumulationRow";
import type { EtfAccumulationStyle } from "../../api/generated/EtfAccumulationStyle";
import type { EtfChangeKind } from "../../api/generated/EtfChangeKind";
import { useElementSize } from "../heatmap-page/useElementSize";
import { useSendSymbol } from "../pages/sendSymbol";
import { Badge, type BadgeTone } from "../ui/Badge";
import { Chip } from "../ui/Chip";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { Failure, Loading, Notice } from "./EtfStates";
import { HelpTip } from "./HelpTip";
import { MaLegend, MaMarks } from "./HoldingsTable";
import {
  type RadarChipFilter,
  filterAccumulationRows,
  formatAccumulationPeriod,
  formatMedianRealChange,
  formatPercent,
  formatRealChange,
  isMaInverseAligned,
  maAlignedCount,
  radarSummary,
} from "./etfModel";

type WindowOption = "5" | "20";

const DIRECTION_CHOICES: readonly SegmentedOption<EtfAccumulationDirection>[] = [
  { value: "buy", label: "동시 매수" },
  { value: "sell", label: "동시 매도" },
];

const WINDOW_CHOICES: readonly SegmentedOption<WindowOption>[] = [
  { value: "5", label: "5일" },
  { value: "20", label: "20일" },
];

const STYLE_CHOICES: readonly SegmentedOption<EtfAccumulationStyle>[] = [
  { value: "active", label: "액티브만" },
  { value: "all", label: "전체" },
];

interface DirectionCopy {
  chips: readonly { value: RadarChipFilter; label: string }[];
  kpiLabel: string;
  kpiTotal: string;
  kpiEdge: string;
  kpiTop: string;
  kpiTopUnit: string;
  kpiTrend: string;
  kpiTrendSub: string;
  radarLegend: readonly { tone: string; label: string }[];
  radarZoneLabel: string;
  radarNullTick: string;
  tableLabel: string;
  tableSectionLabel: string;
  tableHeading: string;
  countHeader: string;
  countAriaVerb: string;
  expandVerb: string;
  contribRegionVerb: string;
  helpLabel: string;
  helpText: string;
  loadingLabel: string;
  failureWhat: string;
  emptyTitle: string;
}

const DIRECTION_COPY: Record<EtfAccumulationDirection, DirectionCopy> = {
  buy: {
    chips: [
      { value: "all", label: "전체" },
      { value: "added", label: "신규 편입 포함" },
      { value: "aligned", label: "이평선 정배열 3▲" },
      { value: "multi", label: "3개+ 동시 매집" },
    ],
    kpiLabel: "동시 매집 요약",
    kpiTotal: "동시 매집 종목",
    kpiEdge: "신규 편입 발생",
    kpiTop: "최다 컨센서스",
    kpiTopUnit: "개 ETF 동시 매수",
    kpiTrend: "이평선 정배열 일치",
    kpiTrendSub: "3▲ 정배열",
    radarLegend: [
      { tone: "added", label: "신규 편입 포함" },
      { tone: "aligned", label: "이평 정배열 3▲" },
      { tone: "normal", label: "일반 매집" },
    ],
    radarZoneLabel: "고확신 구간 (3개+ · +15%↑)",
    radarNullTick: "신규편입",
    tableLabel: "동시 매집 종목 표",
    tableSectionLabel: "동시 매집 종목",
    tableHeading: "동시 매집 순위",
    countHeader: "매수 ETF",
    countAriaVerb: "매수",
    expandVerb: "매집",
    contribRegionVerb: "매집",
    helpLabel: "동시 매집 설명",
    helpText:
      "공통 배율로 CU 크기 변화를 제거한 뒤 기간 내 신규 편입하거나 수량을 1% 넘게 늘린 ETF 수를 종목별로 집계합니다. 공시된 바스켓의 차이이며 실제 체결 내역이 아닙니다.",
    loadingLabel: "동시 매집 종목을 불러오는 중입니다",
    failureWhat: "동시 매집",
    emptyTitle: "이 기간에 동시 매집 종목이 없습니다",
  },
  sell: {
    chips: [
      { value: "all", label: "전체" },
      { value: "added", label: "편출 포함" },
      { value: "aligned", label: "이평선 역배열 0▲" },
      { value: "multi", label: "3개+ 동시 매도" },
    ],
    kpiLabel: "동시 매도 요약",
    kpiTotal: "동시 매도 종목",
    kpiEdge: "전량 편출 발생",
    kpiTop: "최다 이탈 종목",
    kpiTopUnit: "개 ETF 동시 매도",
    kpiTrend: "이평선 역배열 일치",
    kpiTrendSub: "0▲ 역배열",
    radarLegend: [
      { tone: "removed", label: "전량 편출 포함" },
      { tone: "inverse", label: "이평 역배열 0▲" },
      { tone: "normal", label: "일반 매도" },
    ],
    radarZoneLabel: "집중 이탈 구간 (3개+ · -15%↓)",
    radarNullTick: "전량편출",
    tableLabel: "동시 매도 종목 표",
    tableSectionLabel: "동시 매도 종목",
    tableHeading: "동시 매도 순위",
    countHeader: "매도 ETF",
    countAriaVerb: "매도",
    expandVerb: "매도",
    contribRegionVerb: "매도",
    helpLabel: "동시 매도 설명",
    helpText:
      "공통 배율로 CU 크기 변화를 제거한 뒤 기간 내 전량 편출하거나 수량을 1% 넘게 줄인 ETF 수를 종목별로 집계합니다. 공시된 바스켓의 차이이며 실제 체결 내역이 아닙니다.",
    loadingLabel: "동시 매도 종목을 불러오는 중입니다",
    failureWhat: "동시 매도",
    emptyTitle: "이 기간에 동시 매도 종목이 없습니다",
  },
};

const CONTRIBUTOR_BADGE: Record<EtfChangeKind, { tone: BadgeTone; label: string }> = {
  added: { tone: "accent", label: "편입" },
  increased: { tone: "success", label: "늘림" },
  removed: { tone: "warning", label: "편출" },
  decreased: { tone: "danger", label: "줄임" },
  unchanged: { tone: "neutral", label: "유지" },
};

const toWindow = (value: WindowOption): EtfAccumulationWindow => (value === "20" ? 20 : 5);

const rowEtfCount = (row: EtfAccumulationRow, direction: EtfAccumulationDirection): number =>
  direction === "sell" ? row.sellingEtfCount : row.buyingEtfCount;

const RADAR_DEFAULT_W = 720;
const RADAR_H = 216;
const RADAR_LEFT = 48;
const RADAR_RIGHT_PAD = 32;
const RADAR_TOP = 24;
const RADAR_BOTTOM = 182;

interface AccumulationTabProps {
  onOpenFund: (code: string) => void;
  onOpenReverse: (code: string) => void;
}

function RadarKpiStrip({
  rows,
  direction,
}: {
  rows: readonly EtfAccumulationRow[];
  direction: EtfAccumulationDirection;
}) {
  const copy = DIRECTION_COPY[direction];
  const summary = useMemo(() => radarSummary(rows, direction), [rows, direction]);
  const trendPct = summary.total === 0 ? 0 : Math.round((summary.trendStocks / summary.total) * 100);
  return (
    <dl className="etf-radar-kpis etf-card-wide" aria-label={copy.kpiLabel}>
      <div className="etf-summary-cell">
        <dt>{copy.kpiTotal}</dt>
        <dd>{summary.total}종목</dd>
      </div>
      <div className="etf-summary-cell">
        <dt>{copy.kpiEdge}</dt>
        <dd>{summary.edgeStocks}종목</dd>
      </div>
      <div className="etf-summary-cell">
        <dt>{copy.kpiTop}</dt>
        <dd>{summary.topRow ? summary.topRow.name : "-"}</dd>
        {summary.topRow && (
          <dd className="etf-summary-sub">
            {rowEtfCount(summary.topRow, direction)}
            {copy.kpiTopUnit}
          </dd>
        )}
      </div>
      <div className="etf-summary-cell">
        <dt>{copy.kpiTrend}</dt>
        <dd>{summary.trendStocks}종목</dd>
        <dd className="etf-summary-sub">
          {copy.kpiTrendSub} {trendPct}%
        </dd>
      </div>
    </dl>
  );
}

function ConvictionRadar({
  rows,
  direction,
  expanded,
  onToggle,
}: {
  rows: readonly EtfAccumulationRow[];
  direction: EtfAccumulationDirection;
  expanded: string | null;
  onToggle: (code: string) => void;
}) {
  const copy = DIRECTION_COPY[direction];
  const stage = useRef<HTMLDivElement>(null);
  const { w: measuredW } = useElementSize(stage);
  const svgW = Math.max(320, measuredW > 0 ? Math.round(measuredW) : RADAR_DEFAULT_W);
  const radarRight = svgW - RADAR_RIGHT_PAD;
  const magnitude = (change: number | null) =>
    change === null ? null : direction === "sell" ? Math.abs(change) : Math.max(0, change);
  const rawMax = Math.max(0.35, ...rows.map((row) => magnitude(row.medianRealChange) ?? 0));
  const maxChange = Math.max(0.4, Math.ceil(rawMax * 10) / 10);
  const maxCount = Math.max(4, ...rows.map((row) => rowEtfCount(row, direction)));
  const plotW = Math.max(160, radarRight - RADAR_LEFT);
  const plotH = RADAR_BOTTOM - RADAR_TOP;
  const numericSpan = svgW < 420 ? plotW * 0.72 : plotW * 0.82;
  const nullX = Math.min(svgW - 26, RADAR_LEFT + plotW * 0.93);
  const xFor = (mag: number | null) =>
    mag === null
      ? nullX
      : RADAR_LEFT + (Math.min(maxChange, Math.max(0, mag)) / maxChange) * numericSpan;
  const yFor = (count: number) => RADAR_BOTTOM - ((count - 0.5) / maxCount) * plotH;

  const zoneX = xFor(0.15);
  const zoneY = RADAR_TOP;
  const zoneH = Math.max(24, yFor(2.6) - RADAR_TOP);
  const showMidTick = xFor(0.15) - xFor(0) >= 38 && xFor(maxChange) - xFor(0.15) >= 38;
  const xTicks = showMidTick ? [0, 0.15, maxChange] : [0, maxChange];
  const yTicks = Array.from({ length: Math.min(5, maxCount) }, (_, idx) =>
    Math.max(1, Math.round(((idx + 1) * maxCount) / Math.min(5, maxCount))),
  );
  const uniqueYTicks = [...new Set(yTicks)];

  const formatTick = (tick: number) => {
    const pct = Math.round(tick * 100);
    if (direction === "sell") return pct === 0 ? "0%" : `-${pct}%`;
    return `+${pct}%`;
  };

  const bubbleTone = (row: EtfAccumulationRow) => {
    if (direction === "sell") {
      if (row.removedEtfCount > 0) return "removed";
      if (isMaInverseAligned(row.ma)) return "inverse";
      return "normal";
    }
    if (row.addedEtfCount > 0) return "added";
    if (maAlignedCount(row.ma) === 3) return "aligned";
    return "normal";
  };

  const handleKey = (event: KeyboardEvent<SVGGElement>, code: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle(code);
    }
  };

  return (
    <section className="etf-card etf-card-wide" aria-label="컨빅션 버블 레이더">
      <div className="etf-card-head">
        <h3>컨빅션 버블 레이더</h3>
        <div className="etf-radar-legend">
          {copy.radarLegend.map((item) => (
            <span key={item.tone} data-tone={item.tone}>
              {item.label}
            </span>
          ))}
        </div>
      </div>
      <div ref={stage} className="etf-radar-stage">
        <svg
          className="etf-radar-svg"
          width={svgW}
          height={RADAR_H}
          viewBox={`0 0 ${svgW} ${RADAR_H}`}
          role="group"
          aria-label={`컨빅션 버블 레이더 ${rows.length}종목`}
        >
          <rect
            x={zoneX}
            y={zoneY}
            width={Math.max(40, radarRight - zoneX)}
            height={zoneH}
            rx={6}
            className="etf-radar-zone"
            data-direction={direction}
          />
          <text
            x={radarRight - 8}
            y={zoneY + 14}
            textAnchor="end"
            className="etf-radar-zone-label"
            data-direction={direction}
          >
            {copy.radarZoneLabel}
          </text>
          {uniqueYTicks.map((tick) => (
            <g key={tick}>
              <line x1={RADAR_LEFT} x2={radarRight} y1={yFor(tick)} y2={yFor(tick)} className="etf-curve-grid" />
              <text x={RADAR_LEFT - 8} y={yFor(tick) + 4} textAnchor="end" className="etf-curve-axis">
                {tick}개
              </text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <g key={tick}>
              <line x1={xFor(tick)} x2={xFor(tick)} y1={RADAR_TOP} y2={RADAR_BOTTOM} className="etf-curve-grid" />
              <text x={xFor(tick)} y={RADAR_BOTTOM + 16} textAnchor="middle" className="etf-curve-axis">
                {formatTick(tick)}
              </text>
            </g>
          ))}
          <text x={xFor(null)} y={RADAR_BOTTOM + 16} textAnchor="middle" className="etf-curve-axis">
            {copy.radarNullTick}
          </text>
          {rows.map((row, idx) => {
            const count = rowEtfCount(row, direction);
            const cx = xFor(magnitude(row.medianRealChange));
            const jitter = ((idx % 3) - 1) * 5;
            const cy = Math.min(RADAR_BOTTOM - 12, Math.max(RADAR_TOP + 12, yFor(count) + jitter));
            const r = Math.min(18, 7 + count * 2.5);
            const tone = bubbleTone(row);
            const selected = expanded === row.code;
            return (
              <g
                key={row.code}
                role="button"
                tabIndex={0}
                className="etf-radar-bubble"
                data-bubble-code={row.code}
                data-tone={tone}
                data-selected={selected ? "true" : undefined}
                aria-pressed={selected}
                aria-label={`${row.name} ${copy.countAriaVerb} ETF ${count}개`}
                onClick={() => onToggle(row.code)}
                onKeyDown={(event) => handleKey(event, row.code)}
              >
                <circle cx={cx} cy={cy} r={r} className="etf-radar-circle" />
                <text x={cx} y={cy - r - 4} textAnchor="middle" className="etf-radar-label">
                  {row.name}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

function ContributorsPanel({
  stockName,
  direction,
  contributors,
  onOpenFund,
}: {
  stockName: string;
  direction: EtfAccumulationDirection;
  contributors: readonly EtfAccumulationContributor[];
  onOpenFund: (code: string) => void;
}) {
  const copy = DIRECTION_COPY[direction];
  const weightOf = (item: EtfAccumulationContributor) =>
    item.kind === "removed" ? item.beforeWeightBps : item.afterWeightBps;
  const maxWeight = Math.max(100, ...contributors.map((item) => weightOf(item) ?? 0));
  return (
    <div className="etf-acc-contrib" role="region" aria-label={`${stockName} ${copy.contribRegionVerb} ETF 목록`}>
      <ul className="etf-acc-contrib-list">
        {contributors.map((contributor) => {
          const badge = CONTRIBUTOR_BADGE[contributor.kind];
          const weightBps = weightOf(contributor);
          const changeDirection =
            contributor.kind === "increased" ? "up" : contributor.kind === "decreased" ? "down" : "flat";
          const weightLabel =
            contributor.kind === "removed"
              ? contributor.beforeWeightBps !== null
                ? `이전 ${formatPercent(contributor.beforeWeightBps)}`
                : "-"
              : contributor.afterWeightBps !== null
                ? formatPercent(contributor.afterWeightBps)
                : "-";
          return (
            <li key={contributor.fundCode} className="etf-acc-contrib-item">
              <div className="etf-acc-contrib-top">
                <button
                  type="button"
                  className="etf-acc-fund-link"
                  data-fund-code={contributor.fundCode}
                  aria-label={`${contributor.fundName} 구성 보기`}
                  onClick={() => onOpenFund(contributor.fundCode)}
                >
                  <span className="etf-acc-fund-name">{contributor.fundName}</span>
                  <span className="etf-row-code">{contributor.fundCode}</span>
                </button>
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </div>
              <div className="etf-acc-contrib-meta">
                <Badge tone={contributor.style === "active" ? "accent" : "neutral"}>
                  {contributor.style === "active" ? "액티브" : "패시브"}
                </Badge>
                <span className="etf-num etf-acc-contrib-change" data-direction={changeDirection}>
                  {contributor.realChange === null ? "-" : formatRealChange(contributor.realChange)}
                </span>
                <span className="etf-num etf-acc-contrib-weight">{weightLabel}</span>
              </div>
              <div className="etf-acc-contrib-bar" aria-hidden="true">
                <i
                  data-direction={direction}
                  style={{
                    width: `${Math.min(100, Math.round(((weightBps ?? 0) / maxWeight) * 100))}%`,
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AccumulationRows({
  rows,
  direction,
  expanded,
  onToggle,
  onOpenFund,
  onSendStock,
  onOpenReverse,
}: {
  rows: readonly EtfAccumulationRow[];
  direction: EtfAccumulationDirection;
  expanded: string | null;
  onToggle: (code: string) => void;
  onOpenFund: (code: string) => void;
  onSendStock: (row: EtfAccumulationRow) => void;
  onOpenReverse: (code: string) => void;
}) {
  const copy = DIRECTION_COPY[direction];
  return (
    <div className="etf-table-wrap" data-scroll="">
      <MaLegend />
      <table className="etf-table" aria-label={copy.tableLabel}>
        <thead>
          <tr>
            <th scope="col" className="etf-num">순위</th>
            <th scope="col">종목</th>
            <th scope="col" className="etf-num">{copy.countHeader}</th>
            <th scope="col" className="etf-num">중앙 실질 증감</th>
            <th scope="col" className="etf-ma-head">이평선 20·60·120</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const isOpen = expanded === row.code;
            const changeDirection =
              row.medianRealChange === null
                ? "flat"
                : row.medianRealChange > 0
                  ? "up"
                  : row.medianRealChange < 0
                    ? "down"
                    : "flat";
            return (
              <Fragment key={row.code}>
                <tr
                  data-code={row.code}
                  data-expanded={isOpen ? "true" : "false"}
                  aria-expanded={isOpen}
                  onClick={() => onToggle(row.code)}
                >
                  <td className="etf-num etf-rank">{index + 1}</td>
                  <td>
                    <span className="etf-acc-stock-cell">
                      <button
                        type="button"
                        className="etf-row-name"
                        aria-expanded={isOpen}
                        aria-label={`${row.name} ${copy.expandVerb} ETF 펼치기`}
                      >
                        {row.name}
                      </button>
                      <span className="etf-row-code">{row.code}</span>
                      <button
                        type="button"
                        className="btn btn-sm etf-acc-chart-btn"
                        aria-label={`${row.name} 연동 차트로 보내기`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSendStock(row);
                        }}
                      >
                        차트
                      </button>
                      <button
                        type="button"
                        className="etf-mini-btn"
                        aria-label={`${row.name} 역추적`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenReverse(row.code);
                        }}
                      >
                        역추적
                      </button>
                    </span>
                  </td>
                  <td className="etf-num">
                    <span className="etf-acc-count">{rowEtfCount(row, direction)}개</span>
                    {direction === "buy" && row.addedEtfCount > 0 && (
                      <span className="etf-acc-added">신규 {row.addedEtfCount}</span>
                    )}
                    {direction === "sell" && row.removedEtfCount > 0 && (
                      <span className="etf-acc-removed">편출 {row.removedEtfCount}</span>
                    )}
                  </td>
                  <td className="etf-num" data-direction={changeDirection}>
                    {formatMedianRealChange(row.medianRealChange)}
                  </td>
                  <td className="etf-ma-cell">
                    <MaMarks ma={row.ma} />
                  </td>
                </tr>
                {isOpen && (
                  <tr className="etf-acc-detail-row" data-detail-for={row.code}>
                    <td colSpan={5}>
                      <ContributorsPanel
                        stockName={row.name}
                        direction={direction}
                        contributors={row.contributors}
                        onOpenFund={onOpenFund}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AccumulationTab({ onOpenFund, onOpenReverse }: AccumulationTabProps) {
  const [direction, setDirection] = useState<EtfAccumulationDirection>("buy");
  const [windowOption, setWindowOption] = useState<WindowOption>("5");
  const [style, setStyle] = useState<EtfAccumulationStyle>("active");
  const [chip, setChip] = useState<RadarChipFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const send = useSendSymbol();
  const query = useEtfAccumulation(toWindow(windowOption), style, direction);

  const copy = DIRECTION_COPY[direction];
  const data = query.data ?? null;
  const period = data === null ? null : formatAccumulationPeriod(data.fromDate, data.toDate, data.collectedDays);
  const filteredRows = useMemo(
    () => (data === null ? [] : filterAccumulationRows(data.rows, chip, direction)),
    [data, chip, direction],
  );
  const activeExpanded = filteredRows.some((row) => row.code === expanded) ? expanded : null;

  return (
    <>
      <section className="etf-card etf-card-wide" aria-label="동시 매집 조건">
        <div className="etf-acc-controls">
          <Segmented
            label="매집 방향"
            mode="pressed"
            size="sm"
            className="etf-acc-seg"
            options={DIRECTION_CHOICES}
            value={direction}
            onChange={(next) => {
              if (next === direction) return;
              setDirection(next);
              setChip("all");
              setExpanded(null);
            }}
          />
          <Segmented
            label="집계 기간"
            mode="pressed"
            size="sm"
            className="etf-acc-seg"
            options={WINDOW_CHOICES}
            value={windowOption}
            onChange={(next) => {
              if (next === windowOption) return;
              setWindowOption(next);
              setExpanded(null);
            }}
          />
          <Segmented
            label="대상 ETF"
            mode="pressed"
            size="sm"
            className="etf-acc-seg"
            options={STYLE_CHOICES}
            value={style}
            onChange={(next) => {
              if (next === style) return;
              setStyle(next);
              setExpanded(null);
            }}
          />
          <span className="etf-acc-period" role="status">
            {period ?? (data === null ? "" : `수집일 ${data.collectedDays}일`)}
          </span>
          <HelpTip label={copy.helpLabel} text={copy.helpText} />
        </div>
        {data !== null && data.rows.length > 0 && (
          <div className="etf-chip-row" role="group" aria-label="동시 매집 필터">
            {copy.chips.map((option) => (
              <Chip
                key={option.value}
                pressed={chip === option.value}
                onPressedChange={() => {
                  setChip(option.value);
                  setExpanded(null);
                }}
              >
                {option.label}
              </Chip>
            ))}
          </div>
        )}
      </section>
      {query.isPending ? (
        <Loading label={copy.loadingLabel} />
      ) : query.isError ? (
        <Failure what={copy.failureWhat} retry={() => void query.refetch()} />
      ) : query.data.fromDate === null || query.data.toDate === null ? (
        <Notice title="수집일이 2일 이상 쌓이면 집계됩니다">
          {query.data.collectedDays === 0 ? "아직 수집한 날짜가 없습니다" : `현재 수집일 ${query.data.collectedDays}일`}
        </Notice>
      ) : query.data.rows.length === 0 ? (
        <Notice title={copy.emptyTitle}>기간이나 대상 ETF 조건을 바꿔 보세요</Notice>
      ) : (
        <>
          <RadarKpiStrip rows={query.data.rows} direction={direction} />
          {filteredRows.length > 0 && (
            <ConvictionRadar
              rows={filteredRows}
              direction={direction}
              expanded={activeExpanded}
              onToggle={(code) => setExpanded((current) => (current === code ? null : code))}
            />
          )}
          <section className="etf-card etf-card-wide" aria-label={copy.tableSectionLabel}>
            <h3>
              {copy.tableHeading} · {filteredRows.length}종목
              {query.data.maAsOf !== null && <span className="etf-acc-ma-date">이평선 기준일 {query.data.maAsOf}</span>}
            </h3>
            {filteredRows.length === 0 ? (
              <Notice title="선택한 조건에 맞는 종목이 없습니다" wide={false}>
                다른 필터를 선택해 보세요
              </Notice>
            ) : (
              <AccumulationRows
                rows={filteredRows}
                direction={direction}
                expanded={activeExpanded}
                onToggle={(code) => setExpanded((current) => (current === code ? null : code))}
                onOpenFund={onOpenFund}
                onSendStock={(row) => send({ code: row.code, name: row.name })}
                onOpenReverse={onOpenReverse}
              />
            )}
          </section>
        </>
      )}
    </>
  );
}
