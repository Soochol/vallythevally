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
  increased: { tone: "up", label: "늘림" },
  removed: { tone: "warning", label: "편출" },
  decreased: { tone: "down", label: "줄임" },
  unchanged: { tone: "neutral", label: "유지" },
};

const toWindow = (value: WindowOption): EtfAccumulationWindow => (value === "20" ? 20 : 5);

const rowEtfCount = (row: EtfAccumulationRow, direction: EtfAccumulationDirection): number =>
  direction === "sell" ? row.sellingEtfCount : row.buyingEtfCount;

const RADAR_DEFAULT_W = 860;
const RADAR_H = 520;
const RADAR_LEFT = 66;
const RADAR_RIGHT_PAD = 28;
const RADAR_TOP = 42;
const RADAR_BOTTOM = 464;
const RADAR_LOG_GAIN = 9;
const RELAX_ITERATIONS = 42;

interface LabelBox {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

interface PlacedBubbleLabel {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}

function overlapsAny(box: LabelBox, placed: readonly LabelBox[]): boolean {
  for (const other of placed) {
    if (box.x1 < other.x2 && box.x2 > other.x1 && box.y1 < other.y2 && box.y2 > other.y1) return true;
  }
  return false;
}

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
  const [hoveredCode, setHoveredCode] = useState<string | null>(null);
  const svgW = Math.max(360, measuredW > 0 ? Math.round(measuredW) : RADAR_DEFAULT_W);
  const radarRight = svgW - RADAR_RIGHT_PAD;
  const magnitude = (change: number | null) =>
    change === null ? null : direction === "sell" ? Math.abs(change) : Math.max(0, change);
  const rawMax = Math.max(0.4, ...rows.map((row) => magnitude(row.medianRealChange) ?? 0));
  const maxChange = Math.max(0.5, Math.ceil(rawMax * 10) / 10);
  const maxCount = Math.max(4, ...rows.map((row) => rowEtfCount(row, direction)));
  const plotW = Math.max(200, radarRight - RADAR_LEFT);
  const plotH = RADAR_BOTTOM - RADAR_TOP;
  const laneDividerX = RADAR_LEFT + plotW * (svgW < 500 ? 0.78 : 0.84);
  const numericSpan = Math.max(120, laneDividerX - RADAR_LEFT - 24);
  const nullCenterX = (laneDividerX + radarRight) / 2;
  const maxLog = Math.log1p(maxChange * RADAR_LOG_GAIN);
  const xFor = (mag: number | null) =>
    mag === null
      ? nullCenterX
      : RADAR_LEFT + 12 + (Math.log1p(Math.min(maxChange, Math.max(0, mag)) * RADAR_LOG_GAIN) / maxLog) * numericSpan;
  const yFor = (count: number) => RADAR_BOTTOM - ((count - 0.5) / maxCount) * plotH;

  const zoneX = xFor(0.15);
  const zoneY = RADAR_TOP;
  const zoneH = Math.max(34, yFor(2.5) - RADAR_TOP);
  const candidateTicks = [0, 0.08, 0.15, 0.3, 0.5, 1.0, maxChange].filter((tick) => tick <= maxChange + 1e-6);
  const xTicks: number[] = [];
  for (const tick of candidateTicks) {
    const prev = xTicks[xTicks.length - 1];
    if (prev === undefined || xFor(tick) - xFor(prev) >= 54) {
      xTicks.push(tick);
    }
  }
  if (xTicks[xTicks.length - 1] !== maxChange) {
    if (xTicks.length > 1 && xFor(maxChange) - xFor(xTicks[xTicks.length - 1]!) < 48) {
      xTicks[xTicks.length - 1] = maxChange;
    } else {
      xTicks.push(maxChange);
    }
  }
  const yTicks = Array.from({ length: Math.min(8, maxCount) }, (_, idx) =>
    Math.max(1, Math.round(((idx + 1) * maxCount) / Math.min(8, maxCount))),
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

  const positioned = useMemo(() => {
    const items = rows.map((row) => {
      const count = rowEtfCount(row, direction);
      const mag = magnitude(row.medianRealChange);
      const tx = xFor(mag);
      const ty = yFor(count);
      const r = Math.min(28, 10 + count * 3.1);
      const tone = bubbleTone(row);
      const highConviction = count >= 3 && (mag === null || mag >= 0.15);
      return { row, count, mag, tx, ty, cx: tx, cy: ty, r, tone, highConviction, isNull: mag === null };
    });

    const bandHalfH = (plotH / maxCount) * 0.42;
    for (let iter = 0; iter < RELAX_ITERATIONS; iter += 1) {
      for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
          const a = items[i]!;
          const b = items[j]!;
          const dx = b.cx - a.cx;
          const dy = b.cy - a.cy;
          const dist = Math.hypot(dx, dy) || 0.1;
          const minDist = a.r + b.r + 5;
          if (dist < minDist) {
            const push = (minDist - dist) * 0.52;
            const ux = dx / dist;
            const uy = dy / dist;
            a.cx -= ux * push * 0.65;
            a.cy -= uy * push;
            b.cx += ux * push * 0.65;
            b.cy += uy * push;
          }
        }
      }
      for (const item of items) {
        item.cx += (item.tx - item.cx) * 0.14;
        item.cy += (item.ty - item.cy) * 0.12;
        const minX = item.isNull ? laneDividerX + item.r + 6 : RADAR_LEFT + item.r + 6;
        const maxX = item.isNull ? radarRight - item.r - 6 : laneDividerX - item.r - 8;
        item.cx = Math.min(maxX, Math.max(minX, item.cx));
        item.cy = Math.min(
          Math.min(RADAR_BOTTOM - item.r - 4, item.ty + bandHalfH),
          Math.max(Math.max(RADAR_TOP + item.r + 4, item.ty - bandHalfH), item.cy),
        );
      }
    }

    const placedLabels: LabelBox[] = [];
    const bubbleBoxes = items.map((item) => ({
      code: item.row.code,
      x1: item.cx - item.r - 2,
      x2: item.cx + item.r + 2,
      y1: item.cy - item.r - 2,
      y2: item.cy + item.r + 2,
    }));
    const labels = new Map<string, PlacedBubbleLabel>();
    const order = [...items].sort((a, b) => {
      const aSel = expanded === a.row.code ? 1 : 0;
      const bSel = expanded === b.row.code ? 1 : 0;
      if (aSel !== bSel) return bSel - aSel;
      if (a.highConviction !== b.highConviction) return a.highConviction ? -1 : 1;
      if (a.count !== b.count) return b.count - a.count;
      return (b.mag ?? 99) - (a.mag ?? 99);
    });
    for (const item of order) {
      const labelW = Math.max(40, item.row.name.length * 10.5 + 10);
      const labelH = 16;
      const candidates: { label: PlacedBubbleLabel; box: LabelBox }[] = [
        {
          label: { x: item.cx, y: item.cy - item.r - 6, anchor: "middle" },
          box: { x1: item.cx - labelW / 2, x2: item.cx + labelW / 2, y1: item.cy - item.r - 6 - labelH, y2: item.cy - item.r - 4 },
        },
        {
          label: { x: item.cx + item.r + 6, y: item.cy + 4, anchor: "start" },
          box: { x1: item.cx + item.r + 4, x2: item.cx + item.r + 4 + labelW, y1: item.cy - 9, y2: item.cy + 8 },
        },
        {
          label: { x: item.cx, y: item.cy + item.r + 15, anchor: "middle" },
          box: { x1: item.cx - labelW / 2, x2: item.cx + labelW / 2, y1: item.cy + item.r + 2, y2: item.cy + item.r + 2 + labelH },
        },
        {
          label: { x: item.cx - item.r - 6, y: item.cy + 4, anchor: "end" },
          box: { x1: item.cx - item.r - 4 - labelW, x2: item.cx - item.r - 4, y1: item.cy - 9, y2: item.cy + 8 },
        },
      ];
      for (const candidate of candidates) {
        const { box, label } = candidate;
        if (box.x1 < RADAR_LEFT + 2 || box.x2 > radarRight - 2 || box.y1 < RADAR_TOP + 2 || box.y2 > RADAR_BOTTOM - 2) {
          continue;
        }
        const hitBubble = bubbleBoxes.some((bb) => bb.code !== item.row.code && overlapsAny(box, [bb]));
        if (expanded === item.row.code || (!hitBubble && !overlapsAny(box, placedLabels))) {
          placedLabels.push(box);
          labels.set(item.row.code, label);
          break;
        }
      }
    }
    return { items, labels };
  }, [rows, direction, expanded, svgW, maxChange, maxCount, laneDividerX, nullCenterX, numericSpan, plotH, radarRight]);

  const focusCode = hoveredCode ?? expanded;
  const hoveredItem = hoveredCode === null ? null : positioned.items.find((item) => item.row.code === hoveredCode) ?? null;
  const focusItem = focusCode === null ? null : positioned.items.find((item) => item.row.code === focusCode) ?? null;
  const drawOrder = [...positioned.items].sort((a, b) => {
    if (a.row.code === focusCode) return 1;
    if (b.row.code === focusCode) return -1;
    return b.r - a.r;
  });
  const zoneBadgeX = Math.max(zoneX + 8, laneDividerX - 184);

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
            x={laneDividerX}
            y={RADAR_TOP}
            width={Math.max(24, radarRight - laneDividerX)}
            height={plotH}
            rx={0}
            className="etf-radar-lane"
          />
          <line
            x1={laneDividerX}
            x2={laneDividerX}
            y1={RADAR_TOP}
            y2={RADAR_BOTTOM}
            className="etf-radar-lane-divider"
          />
          <text
            x={nullCenterX}
            y={RADAR_TOP - 10}
            textAnchor="middle"
            className="etf-radar-lane-label"
            data-direction={direction}
          >
            {copy.radarNullTick} 전용
          </text>
          <rect
            x={zoneX}
            y={zoneY}
            width={Math.max(40, radarRight - zoneX)}
            height={zoneH}
            rx={2}
            className="etf-radar-zone"
            data-direction={direction}
          />
          <g className="etf-radar-zone-pill" data-direction={direction}>
            <rect x={zoneBadgeX} y={zoneY + 8} width={174} height={22} rx={2} />
            <text
              x={zoneBadgeX + 87}
              y={zoneY + 23}
              textAnchor="middle"
              className="etf-radar-zone-label"
              data-direction={direction}
            >
              {copy.radarZoneLabel}
            </text>
          </g>
          {uniqueYTicks.map((tick) => (
            <g key={tick}>
              <line x1={RADAR_LEFT} x2={radarRight} y1={yFor(tick)} y2={yFor(tick)} className="etf-curve-grid" />
              <text x={RADAR_LEFT - 10} y={yFor(tick) + 4} textAnchor="end" className="etf-radar-tick">
                {tick}개
              </text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <g key={tick}>
              <line x1={xFor(tick)} x2={xFor(tick)} y1={RADAR_TOP} y2={RADAR_BOTTOM} className="etf-curve-grid" />
              <text x={xFor(tick)} y={RADAR_BOTTOM + 20} textAnchor="middle" className="etf-radar-tick">
                {formatTick(tick)}
              </text>
            </g>
          ))}
          <text x={nullCenterX} y={RADAR_BOTTOM + 20} textAnchor="middle" className="etf-radar-lane-tick" data-direction={direction}>
            {copy.radarNullTick}
          </text>
          <text x={(RADAR_LEFT + laneDividerX) / 2} y={RADAR_H - 12} textAnchor="middle" className="etf-radar-axis-title">
            중앙 실질 증감률 (로그 스케일)
          </text>
          <text
            x={16}
            y={(RADAR_TOP + RADAR_BOTTOM) / 2}
            textAnchor="middle"
            className="etf-radar-axis-title"
            transform={`rotate(-90 16 ${(RADAR_TOP + RADAR_BOTTOM) / 2})`}
          >
            동시 {copy.countAriaVerb} ETF 수
          </text>
          {focusItem !== null && (
            <g className="etf-radar-guides" aria-hidden="true">
              <line x1={RADAR_LEFT} x2={focusItem.cx} y1={focusItem.cy} y2={focusItem.cy} />
              <line x1={focusItem.cx} x2={focusItem.cx} y1={focusItem.cy} y2={RADAR_BOTTOM} />
            </g>
          )}
          {drawOrder.map(({ row, count, cx, cy, r, tone, highConviction }) => {
            const selected = expanded === row.code;
            const isFocus = focusCode === row.code;
            const isDimmed = hoveredCode !== null && !isFocus;
            const placed = positioned.labels.get(row.code);
            return (
              <g
                key={row.code}
                role="button"
                tabIndex={0}
                className="etf-radar-bubble"
                data-bubble-code={row.code}
                data-tone={tone}
                data-selected={selected ? "true" : undefined}
                data-dimmed={isDimmed ? "true" : undefined}
                aria-pressed={selected}
                aria-label={`${row.name} ${copy.countAriaVerb} ETF ${count}개`}
                onMouseEnter={() => setHoveredCode(row.code)}
                onMouseLeave={() => setHoveredCode((current) => (current === row.code ? null : current))}
                onFocus={() => setHoveredCode(row.code)}
                onBlur={() => setHoveredCode((current) => (current === row.code ? null : current))}
                onClick={() => onToggle(row.code)}
                onKeyDown={(event) => handleKey(event, row.code)}
              >
                <title>
                  {row.name} · {copy.countAriaVerb} ETF {count}개 · 중앙 실질 증감{" "}
                  {formatMedianRealChange(row.medianRealChange)}
                </title>
                {highConviction && <circle cx={cx} cy={cy} r={r + 5} className="etf-radar-ring" />}
                <circle cx={cx} cy={cy} r={r} className="etf-radar-circle" />
                {r >= 15 && (
                  <text x={cx} y={cy + 4} textAnchor="middle" className="etf-radar-count">
                    {count}
                  </text>
                )}
                {placed !== undefined && (
                  <text
                    x={placed.x}
                    y={placed.y}
                    textAnchor={placed.anchor}
                    className="etf-radar-label"
                    data-strong={highConviction || isFocus ? "true" : undefined}
                  >
                    {row.name}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {hoveredItem !== null && (
          <div
            role="tooltip"
            className="etf-radar-tooltip"
            data-testid="etf-radar-tooltip"
            style={{
              left: `${hoveredItem.cx + hoveredItem.r + 264 > svgW ? Math.max(8, hoveredItem.cx - hoveredItem.r - 258) : hoveredItem.cx + hoveredItem.r + 18}px`,
              top: `${Math.min(RADAR_H - 180, Math.max(8, hoveredItem.cy - 48))}px`,
            }}
          >
            <div className="etf-radar-tt-head">
              <strong>{hoveredItem.row.name}</strong>
              <span className="etf-row-code">{hoveredItem.row.code}</span>
            </div>
            <dl className="etf-radar-tt-stats">
              <div>
                <dt>{copy.countHeader}</dt>
                <dd className="etf-num">
                  {hoveredItem.count}개
                  {direction === "buy" && hoveredItem.row.addedEtfCount > 0 && ` (신규 ${hoveredItem.row.addedEtfCount})`}
                  {direction === "sell" && hoveredItem.row.removedEtfCount > 0 && ` (편출 ${hoveredItem.row.removedEtfCount})`}
                </dd>
              </div>
              <div>
                <dt>중앙 실질 증감</dt>
                <dd className="etf-num" data-direction={direction === "buy" ? "up" : "down"}>
                  {hoveredItem.row.medianRealChange === null
                    ? copy.radarNullTick
                    : formatMedianRealChange(hoveredItem.row.medianRealChange)}
                </dd>
              </div>
            </dl>
            <div className="etf-radar-tt-ma">
              <span>이평선 20·60·120</span>
              <MaMarks ma={hoveredItem.row.ma} />
            </div>
            {hoveredItem.row.contributors.length > 0 && (
              <ul className="etf-radar-tt-funds">
                {hoveredItem.row.contributors.slice(0, 3).map((contributor) => (
                  <li key={contributor.fundCode}>
                    <span className="etf-radar-tt-fname">{contributor.fundName}</span>
                    <span className="etf-num">
                      {contributor.kind === "added"
                        ? "편입"
                        : contributor.kind === "removed"
                          ? "편출"
                          : contributor.realChange === null
                            ? "-"
                            : formatRealChange(contributor.realChange)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
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
          <span className="etf-controls-sep" aria-hidden="true" />
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
          <span className="etf-controls-sep" aria-hidden="true" />
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
