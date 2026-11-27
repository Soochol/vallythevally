import { type PointerEvent as ReactPointerEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Bar } from "../../api/generated/Bar";
import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { formatClock, formatEokWon, formatQuantity } from "../market-window/format";
import { Segmented, type SegmentOption } from "../market-window/parts";
import { EmptyState } from "../overlay/State";
import type { BoardAxis } from "./board";
import { axisGapRanges } from "./history";
import {
  GROUP_LABELS,
  OTHER_BROKER_LABEL,
  brokerGroupOf,
  buildTransferSteps,
  computeTransfer,
  detectTransferEvents,
  layoutSankey,
  type BrokerGroupKind,
  type SankeyLinkLayout,
  type TransferConfidence,
  type TransferEvent,
  type TransferLevel,
  type TransferMode,
  type TransferRange,
} from "./transfer";

export interface TransferViewProps {
  readonly snapshots: readonly FeedBrokers[];
  readonly gapBefore: readonly boolean[];
  readonly gaps: readonly (readonly [UnixSeconds, UnixSeconds])[];
  readonly bars: readonly Bar[];
  readonly axis: BoardAxis;
}

type RangePreset = "all" | "last30" | "last10" | "peak";

type RangeSelection =
  | { readonly kind: "preset"; readonly preset: RangePreset }
  | { readonly kind: "custom"; readonly range: TransferRange; readonly eventT: UnixSeconds | null };

interface FocusNode {
  readonly side: "src" | "dst";
  readonly name: string;
}

interface HoveredLink {
  readonly link: SankeyLinkLayout;
  readonly x: number;
  readonly y: number;
  readonly flipLeft: boolean;
}

type BrushDragKind = "left" | "right" | "move" | "new";

interface BrushDragState {
  readonly kind: BrushDragKind;
  readonly startX: number;
  readonly origFrom: UnixSeconds;
  readonly origTo: UnixSeconds;
  readonly anchorT: UnixSeconds;
}

interface StageSize {
  readonly width: number;
  readonly height: number;
}

const LEVEL_OPTIONS: readonly SegmentOption<TransferLevel>[] = [
  { value: "broker", label: "개별 창구" },
  { value: "group", label: "주체 그룹" },
];

const MODE_OPTIONS: readonly SegmentOption<TransferMode>[] = [
  { value: "net", label: "순이동" },
  { value: "gross", label: "총량" },
];

const PRESET_OPTIONS: readonly { readonly value: RangePreset; readonly label: string }[] = [
  { value: "all", label: "전체" },
  { value: "last30", label: "30분" },
  { value: "last10", label: "10분" },
  { value: "peak", label: "피크" },
];

const CONFIDENCE_LABELS: Record<TransferConfidence, string> = {
  high: "높음",
  medium: "보통",
  low: "낮음",
};

const DEFAULT_STAGE_WIDTH = 560;
const DEFAULT_STAGE_HEIGHT = 320;
const MIN_STAGE_WIDTH = 280;
const MIN_STAGE_HEIGHT = 220;
const BRUSH_WIDTH = 800;
const BRUSH_HEIGHT = 38;
const BRUSH_PLOT_BOTTOM = 26;
const BRUSH_PLOT_TOP = 3;

function formatCompactQty(qty: number): string {
  const abs = Math.abs(qty);
  if (abs >= 1_000_000) return `${(qty / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(qty / 1_000).toFixed(1)}k`;
  return formatQuantity(Math.round(qty));
}

function formatHm(t: UnixSeconds): string {
  return formatClock(t).slice(0, 5);
}

function truncateLabel(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function groupColorToken(group: BrokerGroupKind, side: "src" | "dst", level: TransferLevel): string {
  switch (group) {
    case "foreign":
      return "var(--ind-2)";
    case "retail":
      return "var(--series-1)";
    case "domestic":
      return level === "group" ? "var(--ind-1)" : side === "src" ? "var(--down)" : "var(--up)";
    case "other":
      return "var(--text-3)";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function TransferView({ snapshots, gapBefore, gaps, bars, axis }: TransferViewProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [level, setLevel] = useState<TransferLevel>("broker");
  const [mode, setMode] = useState<TransferMode>("net");
  const [showOther, setShowOther] = useState(true);
  const [selection, setSelection] = useState<RangeSelection>({ kind: "preset", preset: "all" });
  const [focusNode, setFocusNode] = useState<FocusNode | null>(null);
  const [hoveredLink, setHoveredLink] = useState<HoveredLink | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [stageSize, setStageSize] = useState<StageSize>({ width: DEFAULT_STAGE_WIDTH, height: DEFAULT_STAGE_HEIGHT });

  const stageRef = useRef<HTMLDivElement>(null);
  const brushRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<BrushDragState | null>(null);

  useEffect(() => {
    const element = stageRef.current;
    if (element === null) return;
    const syncSize = () => {
      const nextW = Math.max(MIN_STAGE_WIDTH, Math.round(element.clientWidth));
      const nextH = Math.max(MIN_STAGE_HEIGHT, Math.round(element.clientHeight));
      setStageSize((prev) => (prev.width === nextW && prev.height === nextH ? prev : { width: nextW, height: nextH }));
    };
    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [snapshots.length]);

  const steps = useMemo(() => buildTransferSteps(snapshots, gapBefore, bars), [snapshots, gapBefore, bars]);
  const events = useMemo(() => detectTransferEvents(steps, level, mode), [steps, level, mode]);

  const minT = steps.length > 0 ? steps[0]!.t : axis.from;
  const maxT = steps.length > 0 ? steps[steps.length - 1]!.t : axis.to;
  const brushAxis = useMemo<BoardAxis>(
    () => (maxT > minT ? { from: minT, to: maxT } : axis),
    [axis, minT, maxT],
  );
  const brushSpan = Math.max(1, brushAxis.to - brushAxis.from);

  const peakEvent = useMemo<TransferEvent | null>(() => {
    if (events.length === 0) return null;
    let best = events[0]!;
    for (const ev of events) {
      if (ev.score > best.score) best = ev;
    }
    return best;
  }, [events]);

  const activeRange = useMemo<TransferRange>(() => {
    if (selection.kind === "custom") {
      const from = clamp(selection.range.from, minT, maxT);
      const to = clamp(selection.range.to, from, maxT);
      return { from, to };
    }
    switch (selection.preset) {
      case "all":
        return { from: minT, to: maxT };
      case "last30":
        return { from: Math.max(minT, maxT - 1800), to: maxT };
      case "last10":
        return { from: Math.max(minT, maxT - 600), to: maxT };
      case "peak":
        return peakEvent !== null ? { from: peakEvent.from, to: peakEvent.to } : { from: minT, to: maxT };
    }
  }, [selection, minT, maxT, peakEvent]);

  const activeEventT =
    selection.kind === "custom"
      ? selection.eventT
      : selection.preset === "peak" && peakEvent !== null
        ? peakEvent.t
        : null;

  const summary = useMemo(
    () => computeTransfer(steps, activeRange, level, mode),
    [steps, activeRange, level, mode],
  );

  const sankey = useMemo(
    () => layoutSankey(summary, showOther, stageSize.width, stageSize.height),
    [summary, showOther, stageSize.width, stageSize.height],
  );

  const brushSeries = useMemo(() => {
    const inRangeBars = bars.filter((bar) => bar.t >= brushAxis.from && bar.t <= brushAxis.to);
    const pricePoints =
      inRangeBars.length >= 2
        ? inRangeBars.map((bar) => ({ t: bar.t, price: bar.c }))
        : steps.filter((step) => !step.gap && step.price > 0).map((step) => ({ t: step.t, price: step.price }));

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const pt of pricePoints) {
      if (pt.price < minPrice) minPrice = pt.price;
      if (pt.price > maxPrice) maxPrice = pt.price;
    }
    const priceSpan = Number.isFinite(minPrice) && maxPrice > minPrice ? maxPrice - minPrice : 1;

    const volSource = steps.filter((step) => !step.gap && step.vol > 0);
    let maxVol = 1;
    for (const step of volSource) {
      if (step.vol > maxVol) maxVol = step.vol;
    }

    const gapBands = axisGapRanges(gaps, brushAxis);
    const stepGaps = steps
      .filter((step) => step.gap)
      .map((step) => {
        const from = clamp(step.prevT, brushAxis.from, brushAxis.to);
        const to = clamp(step.t, from, brushAxis.to);
        return {
          left: ((from - brushAxis.from) / brushSpan) * 100,
          width: Math.max(0.5, ((to - from) / brushSpan) * 100),
        };
      });

    return {
      pricePoints,
      minPrice: Number.isFinite(minPrice) ? minPrice : 0,
      priceSpan,
      volSource,
      maxVol,
      gapBands: gapBands.length > 0 ? gapBands : stepGaps,
    };
  }, [bars, steps, gaps, brushAxis, brushSpan]);

  const topPairs = useMemo(() => {
    const totalFlow = summary.edges.reduce((acc, edge) => acc + edge.qty, 0) || 1;
    return summary.edges
      .filter((edge) => {
        if (!showOther && edge.isOther) return false;
        if (focusNode !== null) {
          return focusNode.side === "src" ? edge.src === focusNode.name : edge.dst === focusNode.name;
        }
        return true;
      })
      .sort((a, b) => {
        if (a.isOther !== b.isOther) return a.isOther ? 1 : -1;
        return b.qty - a.qty;
      })
      .slice(0, 8)
      .map((edge) => ({ edge, sharePct: (edge.qty / totalFlow) * 100 }));
  }, [summary.edges, showOther, focusNode]);

  const focusDetail = useMemo(() => {
    if (focusNode === null) return null;
    const related = summary.edges
      .filter((edge) => (focusNode.side === "src" ? edge.src === focusNode.name : edge.dst === focusNode.name))
      .filter((edge) => showOther || !edge.isOther)
      .sort((a, b) => b.qty - a.qty);
    const total = related.reduce((acc, edge) => acc + edge.qty, 0);
    if (total <= 0) return null;
    return {
      side: focusNode.side,
      name: focusNode.name,
      total,
      items: related.slice(0, 4).map((edge) => {
        const peer = focusNode.side === "src" ? edge.dst : edge.src;
        return {
          peer,
          qty: edge.qty,
          sharePct: (edge.qty / total) * 100,
          group: brokerGroupOf(peer),
          isOther: peer === summary.otherLabel,
        };
      }),
    };
  }, [focusNode, summary.edges, summary.otherLabel, showOther]);

  if (snapshots.length < 2) {
    return (
      <div className="br-tr" data-testid="broker-transfer-view">
        <EmptyState title="이동 추정에 스냅샷이 2개 이상 필요합니다" />
      </div>
    );
  }

  const handleLevelChange = (next: TransferLevel) => {
    setLevel(next);
    setFocusNode(null);
    setHoveredLink(null);
  };

  const handleModeChange = (next: TransferMode) => {
    setMode(next);
    setFocusNode(null);
    setHoveredLink(null);
  };

  const toggleFocus = (side: "src" | "dst", name: string) => {
    setFocusNode((current) => (current !== null && current.side === side && current.name === name ? null : { side, name }));
  };

  const selectEvent = (ev: TransferEvent) => {
    setSelection({ kind: "custom", range: { from: ev.from, to: ev.to }, eventT: ev.t });
    setFocusNode(null);
  };

  const xOfTime = (t: UnixSeconds) => ((clamp(t, brushAxis.from, brushAxis.to) - brushAxis.from) / brushSpan) * BRUSH_WIDTH;
  const yOfPrice = (price: number) =>
    BRUSH_PLOT_TOP + (1 - (price - brushSeries.minPrice) / brushSeries.priceSpan) * (BRUSH_PLOT_BOTTOM - BRUSH_PLOT_TOP - 4);

  const clientXToTime = (clientX: number): UnixSeconds => {
    const wrap = brushRef.current;
    if (wrap === null) return brushAxis.from;
    const rect = wrap.getBoundingClientRect();
    if (rect.width <= 0) return brushAxis.from;
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return Math.round(brushAxis.from + ratio * brushSpan);
  };

  const minWindowSec = Math.min(60, Math.max(1, Math.round(brushSpan * 0.05)));

  const startBrushDrag = (event: ReactPointerEvent<Element>, kind: BrushDragKind) => {
    event.stopPropagation();
    const wrap = brushRef.current;
    if (wrap === null) return;
    const anchorT = clientXToTime(event.clientX);
    dragRef.current = {
      kind,
      startX: event.clientX,
      origFrom: activeRange.from,
      origTo: activeRange.to,
      anchorT,
    };
    if (kind === "new") {
      const nextFrom = clamp(anchorT, minT, maxT);
      const nextTo = clamp(nextFrom + minWindowSec, nextFrom, maxT);
      setSelection({ kind: "custom", range: { from: nextFrom, to: nextTo }, eventT: null });
    }
    wrap.setPointerCapture(event.pointerId);
  };

  const handleBrushBackgroundDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    startBrushDrag(event, "new");
  };

  const handleBrushMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const wrap = brushRef.current;
    if (drag === null || wrap === null) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width <= 0) return;
    const deltaSec = Math.round(((event.clientX - drag.startX) / rect.width) * brushSpan);

    if (drag.kind === "left") {
      const nextFrom = clamp(drag.origFrom + deltaSec, minT, Math.max(minT, drag.origTo - minWindowSec));
      setSelection({ kind: "custom", range: { from: nextFrom, to: drag.origTo }, eventT: null });
    } else if (drag.kind === "right") {
      const nextTo = clamp(drag.origTo + deltaSec, Math.min(maxT, drag.origFrom + minWindowSec), maxT);
      setSelection({ kind: "custom", range: { from: drag.origFrom, to: nextTo }, eventT: null });
    } else if (drag.kind === "move") {
      const widthSec = drag.origTo - drag.origFrom;
      const nextFrom = clamp(drag.origFrom + deltaSec, minT, Math.max(minT, maxT - widthSec));
      setSelection({ kind: "custom", range: { from: nextFrom, to: nextFrom + widthSec }, eventT: null });
    } else {
      const currentT = clientXToTime(event.clientX);
      const rawFrom = Math.min(drag.anchorT, currentT);
      const rawTo = Math.max(drag.anchorT, currentT);
      const nextFrom = clamp(rawFrom, minT, maxT);
      const nextTo = clamp(Math.max(rawTo, nextFrom + minWindowSec), nextFrom, maxT);
      setSelection({ kind: "custom", range: { from: nextFrom, to: nextTo }, eventT: null });
    }
  };

  const handleBrushUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    const wrap = brushRef.current;
    if (wrap !== null && wrap.hasPointerCapture(event.pointerId)) {
      wrap.releasePointerCapture(event.pointerId);
    }
  };

  const handleLinkPointerMove = (event: ReactPointerEvent<SVGPathElement>, link: SankeyLinkLayout) => {
    const stage = stageRef.current;
    if (stage === null) return;
    const rect = stage.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 8, Math.max(8, rect.width - 8));
    const y = clamp(event.clientY - rect.top, 8, Math.max(8, rect.height - 8));
    setHoveredLink({ link, x, y, flipLeft: x > rect.width * 0.56 });
  };

  const selX0 = xOfTime(activeRange.from);
  const selX1 = xOfTime(activeRange.to);
  const selWidth = Math.max(4, selX1 - selX0);
  const canPan = activeRange.to - activeRange.from < brushSpan * 0.98;

  const tickTimes: UnixSeconds[] = [0, 0.25, 0.5, 0.75, 1].map((ratio) =>
    Math.round(brushAxis.from + ratio * brushSpan),
  );

  const pricePolyline = brushSeries.pricePoints
    .map((pt) => `${xOfTime(pt.t).toFixed(1)},${yOfPrice(pt.price).toFixed(1)}`)
    .join(" ");

  const hatchId = `br-tr-hatch-${uid}`;
  const gapHatchId = `br-tr-gap-${uid}`;

  const honestyNote = !showOther
    ? "기타(6위↓) 숨김 · 상위 창구 간 상대 비중만 표시"
    : summary.volumeEstimated
      ? "추정 이동량 (1분봉 거래량 미수신 구간 보정 · 1:1 체결 상대 비공개)"
      : "추정 이동량 (스냅샷 동시 델타 시간적분 · KRX 1:1 체결 상대 비공개)";

  const rangeSpanMinutes = Math.max(1, Math.round((activeRange.to - activeRange.from) / 60));
  const maxLabelChars = stageSize.width < 400 ? 7 : stageSize.width < 520 ? 9 : 13;
  const leftHeadX = sankey.srcNodes[0] ? sankey.srcNodes[0].x - 8 : 88;
  const rightHeadX = sankey.dstNodes[0] ? sankey.dstNodes[0].x + sankey.dstNodes[0].width + 8 : stageSize.width - 88;

  return (
    <div className="br-tr" data-testid="broker-transfer-view">
      <div className="br-tr-bar">
        <div className="br-tr-controls">
          <Segmented label="집계 단위" options={LEVEL_OPTIONS} value={level} onChange={handleLevelChange} />
          <Segmented label="계산 모드" options={MODE_OPTIONS} value={mode} onChange={handleModeChange} />
          <button
            type="button"
            className="br-tr-toggle"
            data-testid="broker-transfer-toggle-other"
            aria-pressed={showOther}
            title={honestyNote}
            onClick={() => setShowOther((current) => !current)}
          >
            {OTHER_BROKER_LABEL}
          </button>
          <div className="br-tr-presets" role="group" aria-label="시간 구간">
            {PRESET_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="br-tr-preset"
                data-testid={`broker-transfer-preset-${option.value}`}
                aria-pressed={selection.kind === "preset" && selection.preset === option.value}
                disabled={option.value === "peak" && peakEvent === null}
                onClick={() => {
                  setSelection({ kind: "preset", preset: option.value });
                  setFocusNode(null);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="br-tr-kpi" data-testid="broker-transfer-kpi" title={honestyNote}>
          <span className="br-tr-kpi-item">
            <span className="br-tr-kpi-label">량</span>
            <b className="br-tr-kpi-val">{formatCompactQty(summary.totalVol)}</b>
          </span>
          <span className="br-tr-kpi-item">
            <span className="br-tr-kpi-label">포착</span>
            <b className="br-tr-kpi-val" data-tone="down">{`${summary.covSellPct.toFixed(0)}%`}</b>
            <span className="br-tr-kpi-sep">/</span>
            <b className="br-tr-kpi-val" data-tone="up">{`${summary.covBuyPct.toFixed(0)}%`}</b>
          </span>
          <span className="br-tr-kpi-item">
            <span className="br-tr-kpi-label">확인</span>
            <b className="br-tr-kpi-val">{`${summary.identifiedPct.toFixed(0)}%`}</b>
          </span>
          <span
            className="br-tr-conf"
            data-testid="broker-transfer-confidence"
            data-level={summary.confidence}
          >
            {CONFIDENCE_LABELS[summary.confidence]}
          </span>
          <span className="br-tr-range-tag" data-testid="broker-transfer-range">
            {`${formatHm(activeRange.from)}~${formatHm(activeRange.to)} (${rangeSpanMinutes}분)`}
          </span>
        </div>
      </div>

      <div className="br-tr-stage" ref={stageRef} onPointerLeave={() => setHoveredLink(null)}>
        {sankey.links.length === 0 ? (
          <div className="br-tr-empty-stage">선택 구간에 표시할 이동량이 없습니다</div>
        ) : (
          <svg
            className="br-tr-sankey"
            data-testid="broker-transfer-sankey"
            viewBox={`0 0 ${sankey.width} ${sankey.height}`}
            width="100%"
            height="100%"
            preserveAspectRatio="none"
            role="img"
            aria-label="거래원 추정 물량 이동 다이어그램"
          >
            <defs>
              <pattern id={hatchId} width="6" height="6" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
                <rect width="6" height="6" fill="var(--raised)" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--line-strong)" strokeWidth="2" />
              </pattern>
              {sankey.links.map((link, index) => (
                <linearGradient key={link.id} id={`br-tr-grad-${uid}-${index}`} x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor={groupColorToken(link.srcGroup, "src", level)} />
                  <stop offset="100%" stopColor={groupColorToken(link.dstGroup, "dst", level)} />
                </linearGradient>
              ))}
            </defs>

            <text x={leftHeadX} y={13} textAnchor="end" fill="var(--down)" fontSize={11} fontWeight={600}>
              공급 (Δ매도)
            </text>
            <text x={rightHeadX} y={13} textAnchor="start" fill="var(--up)" fontSize={11} fontWeight={600}>
              흡수 (Δ매수)
            </text>

            {sankey.links.map((link, index) => {
              const isFocused =
                focusNode === null ||
                (focusNode.side === "src" && focusNode.name === link.edge.src) ||
                (focusNode.side === "dst" && focusNode.name === link.edge.dst);
              const isHovered = hoveredLink?.link.id === link.id;
              const opacity = isHovered
                ? link.edge.isOther
                  ? 0.45
                  : 0.85
                : focusNode !== null
                  ? isFocused
                    ? link.edge.isOther
                      ? 0.34
                      : 0.78
                    : 0.06
                  : link.edge.isOther
                    ? 0.18
                    : 0.52;
              return (
                <path
                  key={link.id}
                  className="br-tr-link"
                  data-testid="broker-transfer-link"
                  data-src={link.edge.src}
                  data-dst={link.edge.dst}
                  d={link.path}
                  fill={`url(#br-tr-grad-${uid}-${index})`}
                  fillOpacity={opacity}
                  stroke={link.edge.isOther ? "var(--line)" : "none"}
                  strokeDasharray={link.edge.isOther ? "3 3" : undefined}
                  onPointerMove={(event) => handleLinkPointerMove(event, link)}
                  onPointerLeave={() => setHoveredLink(null)}
                />
              );
            })}

            {[...sankey.srcNodes, ...sankey.dstNodes].map((node) => {
              const isSelected = focusNode !== null && focusNode.side === node.side && focusNode.name === node.name;
              const isConnected =
                focusNode === null ||
                isSelected ||
                sankey.links.some((link) =>
                  focusNode.side === "src"
                    ? link.edge.src === focusNode.name && node.side === "dst" && link.edge.dst === node.name
                    : link.edge.dst === focusNode.name && node.side === "src" && link.edge.src === node.name,
                );
              const midY = node.y + node.height / 2;
              const labelX = node.side === "src" ? node.x - 8 : node.x + node.width + 8;
              const textAnchor = node.side === "src" ? "end" : "start";
              const fill = node.isOther ? `url(#${hatchId})` : groupColorToken(node.group, node.side, level);
              const shortName = truncateLabel(node.name, maxLabelChars);
              const showTwoLines = node.height >= 26;

              return (
                <g
                  key={`${node.side}-${node.name}`}
                  className="br-tr-node"
                  data-testid="broker-transfer-node"
                  data-side={node.side}
                  data-name={node.name}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  opacity={isConnected ? 1 : 0.34}
                  onClick={() => toggleFocus(node.side, node.name)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleFocus(node.side, node.name);
                    }
                  }}
                >
                  <title>{`${node.name} · ${formatQuantity(Math.round(node.qty))}주 (${node.sharePct.toFixed(1)}%)`}</title>
                  <rect
                    x={node.x}
                    y={node.y}
                    width={node.width}
                    height={node.height}
                    rx={2}
                    fill={fill}
                    stroke={isSelected ? "var(--text)" : node.isOther ? "var(--line-strong)" : "var(--bg)"}
                    strokeWidth={isSelected ? 1.8 : 1}
                    strokeDasharray={node.isOther ? "3 2" : undefined}
                  />
                  {showTwoLines ? (
                    <>
                      <text
                        x={labelX}
                        y={midY - 2}
                        textAnchor={textAnchor}
                        fill={node.isOther ? "var(--text-2)" : "var(--text)"}
                        fontSize={12}
                        fontWeight={node.isOther ? 500 : 600}
                      >
                        {shortName}
                      </text>
                      <text
                        x={labelX}
                        y={midY + 12}
                        textAnchor={textAnchor}
                        fill="var(--text-2)"
                        fontSize={11}
                        fontWeight={400}
                      >
                        {`${formatCompactQty(node.qty)} (${node.sharePct.toFixed(0)}%)`}
                      </text>
                    </>
                  ) : (
                    <text
                      x={labelX}
                      y={midY + 4}
                      textAnchor={textAnchor}
                      fill={node.isOther ? "var(--text-2)" : "var(--text)"}
                      fontSize={11}
                      fontWeight={node.isOther ? 500 : 600}
                    >
                      {`${shortName} ${formatCompactQty(node.qty)}`}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}

        {hoveredLink !== null && (
          <div
            className="br-tr-tooltip"
            data-testid="broker-transfer-tooltip"
            data-flip={hoveredLink.flipLeft ? "left" : "right"}
            style={{ left: `${hoveredLink.x}px`, top: `${hoveredLink.y}px` }}
          >
            <div className="br-tr-tip-title">
              <span data-tone="down">{hoveredLink.link.edge.src}</span>
              <span className="br-tr-tip-arrow">→</span>
              <span data-tone="up">{hoveredLink.link.edge.dst}</span>
            </div>
            <div className="br-tr-tip-row">
              <span>추정 이동량</span>
              <b>{`${formatQuantity(Math.round(hoveredLink.link.edge.qty))}주`}</b>
            </div>
            <div className="br-tr-tip-row">
              <span>추정 거래대금</span>
              <b>{formatEokWon(hoveredLink.link.edge.valueWon)}</b>
            </div>
            <div className="br-tr-tip-row">
              <span>{`${hoveredLink.link.edge.src} 매도 중`}</span>
              <b>{`${hoveredLink.link.srcSharePct.toFixed(1)}%`}</b>
            </div>
            <div className="br-tr-tip-row">
              <span>{`${hoveredLink.link.edge.dst} 매수 중`}</span>
              <b>{`${hoveredLink.link.dstSharePct.toFixed(1)}%`}</b>
            </div>
            <div className="br-tr-tip-row">
              <span>최대 동시 시각</span>
              <b>{formatHm(hoveredLink.link.edge.peakT)}</b>
            </div>
            <div className="br-tr-tip-note">
              {hoveredLink.link.edge.isOther
                ? "6위 이하 미확인 창구 잔여 물량 포함"
                : "스냅샷 동시 델타 기반 추정치 (1:1 확정 아님)"}
            </div>
          </div>
        )}
      </div>

      {focusDetail !== null && (
        <div className="br-tr-focus-strip" data-testid="broker-transfer-focus">
          <span className="br-tr-focus-label">
            <b>{focusDetail.name}</b>
            <span>{`${focusDetail.side === "src" ? "공급" : "흡수"} ${formatCompactQty(focusDetail.total)}주`}</span>
          </span>
          <div className="br-tr-focus-peers">
            {focusDetail.items.map((item) => (
              <span key={item.peer} className="br-tr-focus-chip" data-muted={item.isOther ? "" : undefined}>
                {`${focusDetail.side === "src" ? "→" : "←"}${item.peer} ${item.sharePct.toFixed(0)}%`}
              </span>
            ))}
          </div>
          <button type="button" className="br-tr-clear-btn" onClick={() => setFocusNode(null)}>
            해제
          </button>
        </div>
      )}

      <div className="br-tr-bottom">
        <div
          ref={brushRef}
          className="br-tr-brush-wrap"
          data-testid="broker-transfer-brush"
          title="양 끝 핸들 드래그로 구간 조정 · 핀 클릭 시 ±3분 확대"
          onPointerDown={handleBrushBackgroundDown}
          onPointerMove={handleBrushMove}
          onPointerUp={handleBrushUp}
          onPointerCancel={handleBrushUp}
        >
          <svg className="br-tr-brush-svg" viewBox={`0 0 ${BRUSH_WIDTH} ${BRUSH_HEIGHT}`} preserveAspectRatio="none">
            <defs>
              <pattern id={gapHatchId} width="6" height="6" patternTransform="rotate(-45 0 0)" patternUnits="userSpaceOnUse">
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--line-strong)" strokeWidth="2" />
              </pattern>
            </defs>

            {brushSeries.gapBands.map((band, index) => (
              <rect
                key={index}
                x={(band.left / 100) * BRUSH_WIDTH}
                y={0}
                width={Math.max(4, (band.width / 100) * BRUSH_WIDTH)}
                height={BRUSH_PLOT_BOTTOM}
                fill={`url(#${gapHatchId})`}
              />
            ))}

            {brushSeries.volSource.map((step) => {
              const bh = Math.max(1, (step.vol / brushSeries.maxVol) * (BRUSH_PLOT_BOTTOM * 0.65));
              return (
                <rect
                  key={step.t}
                  x={xOfTime(step.t)}
                  y={BRUSH_PLOT_BOTTOM - bh}
                  width={2.5}
                  height={bh}
                  fill="var(--line-strong)"
                  fillOpacity={0.6}
                />
              );
            })}

            {pricePolyline.length > 0 && (
              <polyline points={pricePolyline} fill="none" stroke="var(--text-2)" strokeWidth="1.4" />
            )}

            <rect x={0} y={0} width={selX0} height={BRUSH_PLOT_BOTTOM} fill="var(--scrim)" fillOpacity={0.55} />
            <rect
              x={selX1}
              y={0}
              width={Math.max(0, BRUSH_WIDTH - selX1)}
              height={BRUSH_PLOT_BOTTOM}
              fill="var(--scrim)"
              fillOpacity={0.55}
            />

            <rect
              className="br-tr-brush-sel"
              data-can-pan={canPan ? "true" : "false"}
              x={selX0}
              y={1}
              width={selWidth}
              height={BRUSH_PLOT_BOTTOM - 2}
              fill="var(--accent-soft)"
              stroke="var(--accent)"
              strokeWidth="1.2"
              onPointerDown={(event) => startBrushDrag(event, canPan ? "move" : "new")}
            />

            <rect
              className="br-tr-brush-handle"
              data-testid="broker-transfer-brush-left"
              x={selX0 - 5}
              y={3}
              width={10}
              height={20}
              rx={2}
              fill="var(--accent)"
              onPointerDown={(event) => startBrushDrag(event, "left")}
            />
            <rect
              className="br-tr-brush-handle"
              data-testid="broker-transfer-brush-right"
              x={selX1 - 5}
              y={3}
              width={10}
              height={20}
              rx={2}
              fill="var(--accent)"
              onPointerDown={(event) => startBrushDrag(event, "right")}
            />

            {events.map((ev) => {
              const cx = xOfTime(ev.t);
              const cy = 9;
              const isActive = activeEventT === ev.t;
              return (
                <g
                  key={ev.t}
                  className="br-tr-pin"
                  data-testid="broker-transfer-pin"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectEvent(ev);
                  }}
                >
                  <line
                    x1={cx}
                    y1={0}
                    x2={cx}
                    y2={BRUSH_PLOT_BOTTOM}
                    stroke="var(--accent)"
                    strokeOpacity={isActive ? 0.9 : 0.45}
                    strokeDasharray="2 2"
                  />
                  <polygon
                    points={`${cx},${cy - 4} ${cx + 4},${cy} ${cx},${cy + 4} ${cx - 4},${cy}`}
                    fill={isActive ? "var(--accent)" : "var(--surface)"}
                    stroke="var(--accent)"
                    strokeWidth="1.4"
                  />
                </g>
              );
            })}

            <line x1={0} y1={BRUSH_PLOT_BOTTOM} x2={BRUSH_WIDTH} y2={BRUSH_PLOT_BOTTOM} stroke="var(--line)" />
            {tickTimes.map((t, index) => {
              const tx = clamp(xOfTime(t), 22, BRUSH_WIDTH - 22);
              return (
                <text key={index} x={tx} y={BRUSH_HEIGHT - 2} textAnchor="middle" fill="var(--text-3)" fontSize={11}>
                  {formatHm(t)}
                </text>
              );
            })}
          </svg>
        </div>

        <div className="br-tr-event-bar" data-testid="broker-transfer-events">
          <div className="br-tr-event-chips">
            {events.length === 0 ? (
              <span className="br-tr-event-none">{`스냅샷 ${summary.stepCount}개 적분 · 포착 이벤트 없음`}</span>
            ) : (
              events.map((ev) => (
                <button
                  key={ev.t}
                  type="button"
                  className="br-tr-ev-chip"
                  data-testid="broker-transfer-event-item"
                  aria-pressed={activeEventT === ev.t}
                  title={`${formatHm(ev.from)}~${formatHm(ev.to)} · 추정 ${formatCompactQty(ev.qty)}주 (${formatEokWon(ev.valueWon)}) · 포착 ${ev.covAvg.toFixed(0)}%`}
                  onClick={() => selectEvent(ev)}
                >
                  <span className="br-tr-ev-time">{formatHm(ev.t)}</span>
                  <span data-tone="down">{ev.src}</span>
                  <span className="br-tr-ev-arrow">→</span>
                  <span data-tone="up">{ev.dst}</span>
                  <span className="br-tr-ev-qty">{formatCompactQty(ev.qty)}</span>
                </button>
              ))
            )}
          </div>
          <button
            type="button"
            className="br-tr-drawer-btn"
            data-testid="broker-transfer-details-toggle"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((current) => !current)}
          >
            {detailsOpen ? "경로 접기" : `경로 ${topPairs.length}`}
          </button>
        </div>

        {detailsOpen && (
          <div className="br-tr-drawer" data-testid="broker-transfer-pairs">
            {topPairs.length === 0 ? (
              <div className="br-tr-empty-box">표시할 추정 경로가 없습니다</div>
            ) : (
              <div className="br-tr-pair-list">
                {topPairs.map(({ edge, sharePct }) => (
                  <button
                    key={`${edge.src}=>${edge.dst}`}
                    type="button"
                    className="br-tr-pair"
                    data-testid="broker-transfer-pair-row"
                    data-muted={edge.isOther ? "" : undefined}
                    onClick={() => toggleFocus("src", edge.src)}
                  >
                    <span className="br-tr-pair-route">
                      <span data-tone={edge.src === summary.otherLabel ? "other" : "down"}>{edge.src}</span>
                      <span className="br-tr-pair-arrow">→</span>
                      <span data-tone={edge.dst === summary.otherLabel ? "other" : "up"}>{edge.dst}</span>
                    </span>
                    <span className="br-tr-pair-qty">{`${formatCompactQty(edge.qty)}주`}</span>
                    <span className="br-tr-pair-pct">{`${sharePct.toFixed(1)}%`}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="br-tr-drawer-foot">
              <span>{honestyNote}</span>
              <span className="br-tr-legend">
                <span><i className="br-tr-dot" data-group="foreign" />{GROUP_LABELS.foreign}</span>
                <span><i className="br-tr-dot" data-group="retail" />{GROUP_LABELS.retail}</span>
                <span><i className="br-tr-dot" data-group="domestic" />{GROUP_LABELS.domestic}</span>
                <span><i className="br-tr-dot" data-group="other" />{GROUP_LABELS.other}</span>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
