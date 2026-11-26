import { type MouseEvent, useMemo, useRef, useState } from "react";
import { type EtfSharesDays, useEtfShares } from "../../api/etf";
import type { EtfSharesPoint } from "../../api/generated/EtfSharesPoint";
import { ApiRequestError } from "../../api/http";
import { useSendSymbol } from "../pages/sendSymbol";
import { Badge } from "../ui/Badge";
import { Chip } from "../ui/Chip";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { Failure, Loading, Notice } from "./EtfStates";
import { HelpTip } from "./HelpTip";
import { SharesNotConfiguredCard, SharesStatusBanner } from "./SharesStatusCard";
import {
  flowDirectionOf,
  formatAumWon,
  formatFlowWon,
  formatPremiumBps,
  formatSharesCount,
  formatSignedPercent,
} from "./etfModel";

type DaysOption = "20" | "60" | "120";
type OverlayKey = "shares" | "cumFlow" | "aum" | "nav";

const DAYS_CHOICES: readonly SegmentedOption<DaysOption>[] = [
  { value: "20", label: "20일" },
  { value: "60", label: "60일" },
  { value: "120", label: "120일" },
];

const OVERLAY_OPTIONS: readonly { key: OverlayKey; label: string; tone: string }[] = [
  { key: "shares", label: "상장좌수", tone: "accent" },
  { key: "cumFlow", label: "누적 순유입", tone: "series1" },
  { key: "aum", label: "순자산(AUM)", tone: "ind1" },
  { key: "nav", label: "NAV", tone: "series2" },
];

const toDays = (value: DaysOption): EtfSharesDays => (value === "20" ? 20 : value === "120" ? 120 : 60);

const CHART_W = 900;
const CHART_H = 370;
const PAD_L = 74;
const PAD_R = 72;
const TOP_Y = 20;
const TOP_H = 176;
const TOP_BOT = TOP_Y + TOP_H;
const BOT_Y = TOP_BOT + 26;
const BOT_H = 110;
const BOT_BOT = BOT_Y + BOT_H;
const PLOT_W = CHART_W - PAD_L - PAD_R;

interface AxisScale {
  min: number;
  max: number;
  y: (value: number) => number;
}

function makeScale(values: readonly number[], includeZero: boolean): AxisScale {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (includeZero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  const span = Math.max(1, max - min);
  const lo = min - span * 0.08;
  const full = span * 1.16;
  return {
    min: lo,
    max: lo + full,
    y: (value: number) => TOP_BOT - ((value - lo) / full) * TOP_H,
  };
}

function SharesComboChart({
  points,
  overlays,
}: {
  points: readonly EtfSharesPoint[];
  overlays: Record<OverlayKey, boolean>;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const count = points.length;
  const xAt = (idx: number) => PAD_L + (count <= 1 ? PLOT_W / 2 : (idx / (count - 1)) * PLOT_W);

  const sharesScale = useMemo(() => makeScale(points.map((p) => p.listedShares), false), [points]);
  const cumScale = useMemo(() => makeScale(points.map((p) => p.cumNetFlowWon), true), [points]);
  const aumScale = useMemo(() => makeScale(points.map((p) => p.aumWon), false), [points]);
  const navScale = useMemo(() => makeScale(points.map((p) => p.nav), false), [points]);

  const secondaryKey: OverlayKey | null = overlays.cumFlow
    ? "cumFlow"
    : overlays.aum
      ? "aum"
      : overlays.nav
        ? "nav"
        : null;

  const maxAbsFlow = useMemo(
    () => Math.max(100_000_000, ...points.map((p) => Math.abs(p.netFlowWon))),
    [points],
  );

  const midBot = BOT_Y + BOT_H / 2;
  const barWidth = Math.max(3, Math.min(14, (PLOT_W / Math.max(1, count)) * 0.65));

  const sharesPolyline = points.map((p, i) => `${xAt(i).toFixed(1)},${sharesScale.y(p.listedShares).toFixed(1)}`).join(" ");
  const sharesArea =
    count > 0
      ? `M ${xAt(0).toFixed(1)},${TOP_BOT} L ${sharesPolyline.replace(/ /g, " L ")} L ${xAt(count - 1).toFixed(1)},${TOP_BOT} Z`
      : "";

  const cumPolyline = points.map((p, i) => `${xAt(i).toFixed(1)},${cumScale.y(p.cumNetFlowWon).toFixed(1)}`).join(" ");
  const aumPolyline = points.map((p, i) => `${xAt(i).toFixed(1)},${aumScale.y(p.aumWon).toFixed(1)}`).join(" ");
  const navPolyline = points.map((p, i) => `${xAt(i).toFixed(1)},${navScale.y(p.nav).toFixed(1)}`).join(" ");

  const xTickIndices = useMemo(() => {
    const tickCount = Math.min(6, count);
    if (tickCount === 0) return [];
    return Array.from({ length: tickCount }, (_, idx) =>
      Math.round((idx / Math.max(1, tickCount - 1)) * (count - 1)),
    );
  }, [count]);

  const handleMouseMove = (event: MouseEvent<SVGRectElement>) => {
    const svg = svgRef.current;
    if (svg === null || count === 0) return;
    const rect = svg.getBoundingClientRect();
    const relX = ((event.clientX - rect.left) / rect.width) * CHART_W;
    const ratio = Math.max(0, Math.min(1, (relX - PAD_L) / PLOT_W));
    setHoveredIdx(Math.round(ratio * (count - 1)));
  };

  const latest = points[count - 1]!;
  const hovered = hoveredIdx !== null ? points[hoveredIdx] ?? null : null;
  const hoverX = hoveredIdx !== null ? xAt(hoveredIdx) : 0;
  const placeLeft = hoverX > CHART_W * 0.6;

  return (
    <>
      <div className="etf-lens-bar" data-hover={hovered !== null ? "true" : "false"} role="status">
        {hovered !== null ? (
          <>
            <span className="etf-lens-focus-name">{hovered.date}</span>
            <span className="etf-lens-focus-stat">
              상장좌수 {hovered.listedShares.toLocaleString("ko-KR")}좌
            </span>
            <span className="etf-lens-focus-stat">
              증감 {hovered.splitAdjusted ? "분할보정" : formatSharesCount(hovered.shareDelta, true)}
            </span>
            <span className="etf-lens-focus-stat">
              순유입 {hovered.splitAdjusted ? "0억" : formatFlowWon(hovered.netFlowWon, true)}
            </span>
            <span className="etf-lens-focus-stat">누적 {formatFlowWon(hovered.cumNetFlowWon, true)}</span>
            <span className="etf-lens-focus-stat">AUM {formatAumWon(hovered.aumWon)}</span>
          </>
        ) : (
          <>
            <span className="etf-lens-swatch" data-swatch="accent">
              상장좌수 {formatSharesCount(latest.listedShares)}
            </span>
            <span className="etf-lens-swatch" data-swatch="up">
              일별 순유입
            </span>
            <span className="etf-lens-swatch" data-swatch="down">
              일별 순유출
            </span>
            <span className="etf-lens-note">
              구간 누적 {formatFlowWon(latest.cumNetFlowWon, true)} · 차트에 올리면 날짜별 좌수·자금·NAV를 보입니다
            </span>
          </>
        )}
      </div>

      <div className="etf-shares-stage" ref={stageRef}>
        <svg
          ref={svgRef}
          className="etf-shares-svg"
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          role="img"
          aria-label="일자별 상장좌수 및 추정 순자금 유출입 차트"
        >
          <text x={PAD_L + 4} y={TOP_Y + 11} className="etf-shares-section-label">
            상장좌수 추이 (좌축)
          </text>
          <text x={PAD_L + 4} y={BOT_Y - 6} className="etf-shares-section-label">
            일별 추정 순유입 · 순유출
          </text>

          {[0, 0.33, 0.67, 1].map((step) => {
            const y = TOP_BOT - step * TOP_H;
            const value = sharesScale.min + step * (sharesScale.max - sharesScale.min);
            return (
              <g key={step}>
                <line x1={PAD_L} y1={y} x2={CHART_W - PAD_R} y2={y} className="etf-curve-grid" />
                <text x={PAD_L - 8} y={y + 4} textAnchor="end" className="etf-shares-axis">
                  {formatSharesCount(Math.round(value))}
                </text>
              </g>
            );
          })}

          {secondaryKey !== null &&
            [0, 0.5, 1].map((step) => {
              const y = TOP_BOT - step * TOP_H;
              const scale =
                secondaryKey === "cumFlow" ? cumScale : secondaryKey === "aum" ? aumScale : navScale;
              const value = scale.min + step * (scale.max - scale.min);
              const text =
                secondaryKey === "cumFlow"
                  ? formatFlowWon(value, true)
                  : secondaryKey === "aum"
                    ? formatAumWon(value)
                    : `${Math.round(value).toLocaleString("ko-KR")}원`;
              return (
                <text
                  key={step}
                  x={CHART_W - PAD_R + 8}
                  y={y + 4}
                  textAnchor="start"
                  className="etf-shares-axis-right"
                  data-overlay={secondaryKey}
                >
                  {text}
                </text>
              );
            })}

          {overlays.shares && count > 0 && (
            <>
              <path d={sharesArea} className="etf-curve-area" />
              <polyline points={sharesPolyline} fill="none" className="etf-curve-line" />
            </>
          )}
          {overlays.cumFlow && count > 0 && (
            <polyline points={cumPolyline} fill="none" className="etf-shares-line-cum" />
          )}
          {overlays.aum && count > 0 && (
            <polyline points={aumPolyline} fill="none" className="etf-shares-line-aum" />
          )}
          {overlays.nav && count > 0 && (
            <polyline points={navPolyline} fill="none" className="etf-shares-line-nav" />
          )}

          <line x1={PAD_L} y1={TOP_BOT} x2={CHART_W - PAD_R} y2={TOP_BOT} className="etf-curve-grid" />
          <line x1={PAD_L} y1={midBot} x2={CHART_W - PAD_R} y2={midBot} className="etf-shares-zero" />

          <text x={PAD_L - 8} y={BOT_Y + 10} textAnchor="end" className="etf-shares-axis" data-tone="up">
            +{formatFlowWon(maxAbsFlow, false)}
          </text>
          <text x={PAD_L - 8} y={midBot + 4} textAnchor="end" className="etf-shares-axis">
            0
          </text>
          <text x={PAD_L - 8} y={BOT_BOT - 2} textAnchor="end" className="etf-shares-axis" data-tone="down">
            -{formatFlowWon(maxAbsFlow, false)}
          </text>

          {points.map((point, idx) => {
            const cx = xAt(idx);
            if (point.splitAdjusted) {
              return (
                <g key={point.date} data-split-date={point.date}>
                  <line x1={cx} y1={TOP_Y} x2={cx} y2={BOT_BOT} className="etf-shares-split-line" />
                  <text x={cx} y={TOP_Y + 14} textAnchor="middle" className="etf-shares-split-label">
                    분할보정
                  </text>
                </g>
              );
            }
            const h = (Math.abs(point.netFlowWon) / maxAbsFlow) * (BOT_H / 2 - 6);
            const y = point.netFlowWon >= 0 ? midBot - h : midBot;
            return (
              <rect
                key={point.date}
                x={cx - barWidth / 2}
                y={y}
                width={barWidth}
                height={Math.max(1.2, h)}
                rx={1.5}
                className="etf-shares-flow-bar"
                data-tone={point.netFlowWon >= 0 ? "up" : "down"}
              />
            );
          })}

          {xTickIndices.map((idx) => (
            <text
              key={idx}
              x={xAt(idx)}
              y={BOT_BOT + 18}
              textAnchor="middle"
              className="etf-shares-axis"
            >
              {points[idx]!.date.slice(5)}
            </text>
          ))}

          {hovered !== null && (
            <g className="etf-shares-crosshair">
              <line x1={hoverX} y1={TOP_Y} x2={hoverX} y2={BOT_BOT} className="etf-curve-hover-line" />
              {overlays.shares && (
                <circle
                  cx={hoverX}
                  cy={sharesScale.y(hovered.listedShares)}
                  r={4.5}
                  className="etf-curve-hover-dot"
                />
              )}
              {overlays.cumFlow && (
                <circle
                  cx={hoverX}
                  cy={cumScale.y(hovered.cumNetFlowWon)}
                  r={4}
                  className="etf-shares-hover-cum"
                />
              )}
            </g>
          )}

          <rect
            x={PAD_L}
            y={TOP_Y}
            width={PLOT_W}
            height={BOT_BOT - TOP_Y}
            className="etf-shares-hit"
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHoveredIdx(null)}
          />
        </svg>

        {hovered !== null && (
          <div
            className="etf-shares-tooltip"
            data-testid="etf-shares-tooltip"
            data-side={placeLeft ? "left" : "right"}
          >
            <div className="etf-radar-tt-head">
              <strong>{hovered.date}</strong>
              {hovered.splitAdjusted ? (
                <Badge tone="warning">분할보정</Badge>
              ) : (
                <Badge
                  tone={
                    hovered.netFlowWon > 0 ? "success" : hovered.netFlowWon < 0 ? "danger" : "neutral"
                  }
                >
                  {hovered.netFlowWon > 0 ? "설정 유입" : hovered.netFlowWon < 0 ? "환매 유출" : "변동 없음"}
                </Badge>
              )}
            </div>
            <dl className="etf-shares-tt-grid">
              <dt>상장좌수</dt>
              <dd>{hovered.listedShares.toLocaleString("ko-KR")}좌</dd>
              <dt>좌수 증감</dt>
              <dd data-direction={flowDirectionOf(hovered.shareDelta)}>
                {hovered.splitAdjusted ? "분할 (0 처리)" : formatSharesCount(hovered.shareDelta, true)}
              </dd>
              <dt>추정 순유입</dt>
              <dd data-direction={flowDirectionOf(hovered.netFlowWon)}>
                {hovered.splitAdjusted ? "0억" : formatFlowWon(hovered.netFlowWon, true)}
              </dd>
              <dt>구간 누적</dt>
              <dd data-direction={flowDirectionOf(hovered.cumNetFlowWon)}>
                {formatFlowWon(hovered.cumNetFlowWon, true)}
              </dd>
              <dt>순자산총액</dt>
              <dd>{formatAumWon(hovered.aumWon)}</dd>
              <dt>NAV / 종가</dt>
              <dd>
                {Math.round(hovered.nav).toLocaleString("ko-KR")} /{" "}
                {hovered.closePrice.toLocaleString("ko-KR")}원
              </dd>
              <dt>괴리율</dt>
              <dd>{formatPremiumBps(hovered.premiumBps)}</dd>
            </dl>
          </div>
        )}
      </div>
    </>
  );
}

interface SharesTabProps {
  code: string;
  hasCatalogHero: boolean;
  onOpenFlows: () => void;
  onOpenHistory: () => void;
}

export function SharesTab({ code, hasCatalogHero, onOpenFlows, onOpenHistory }: SharesTabProps) {
  const [daysOption, setDaysOption] = useState<DaysOption>("60");
  const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>({
    shares: true,
    cumFlow: true,
    aum: false,
    nav: false,
  });
  const send = useSendSymbol();
  const series = useEtfShares(code, toDays(daysOption));

  const toggleOverlay = (key: OverlayKey) => {
    setOverlays((prev) => {
      const next = !prev[key];
      const activeCount = Object.values(prev).filter(Boolean).length;
      if (!next && activeCount <= 1) return prev;
      return { ...prev, [key]: next };
    });
  };

  if (series.isPending) return <Loading label="상장좌수·자금 흐름을 불러오는 중입니다" />;
  if (series.isError) {
    const missing = series.error instanceof ApiRequestError && series.error.code === "not_found";
    return missing ? (
      <Notice title="상장좌수 자료가 없는 ETF입니다" role="alert">
        {code} 코드의 KRX 상장좌수 수집본을 찾지 못했습니다.
      </Notice>
    ) : (
      <Failure what="상장좌수·자금 흐름" retry={() => void series.refetch()} />
    );
  }

  const { status, name, inCatalog, latest, points } = series.data;
  const displayName = name ?? code;

  const extraHero = !hasCatalogHero ? (
    <header className="etf-hero etf-card-wide">
      <div className="etf-hero-copy">
        <h2>{displayName}</h2>
        <div className="etf-chips">
          <span>{code}</span>
          <span>KRX 전종목 확장</span>
        </div>
      </div>
      <div className="etf-hero-actions">
        <button type="button" className="btn btn-sm" onClick={onOpenFlows}>
          ← 자금 흐름
        </button>
        <button type="button" className="btn btn-sm" onClick={() => send({ code, name: displayName })}>
          ETF 차트
        </button>
      </div>
    </header>
  ) : null;

  if (status.state === "not_configured") {
    return (
      <>
        {extraHero}
        <SharesNotConfiguredCard />
      </>
    );
  }

  if (latest === null || points.length === 0) {
    return (
      <>
        {extraHero}
        <SharesStatusBanner status={status} />
        <Notice title="수집된 상장좌수 시계열이 아직 없습니다">
          KRX 일별매매정보가 수집되면 날짜별 상장좌수와 순자금 유출입이 여기에 표시됩니다.
        </Notice>
      </>
    );
  }

  const prevPoint = points.length >= 2 ? points[points.length - 2]! : latest;
  const lastPoint = points[points.length - 1]!;
  const daySharePct =
    prevPoint.listedShares > 0 && !lastPoint.splitAdjusted
      ? (lastPoint.shareDelta / prevPoint.listedShares) * 100
      : null;
  const hasSplit = points.some((p) => p.splitAdjusted);

  return (
    <>
      {extraHero}
      <SharesStatusBanner status={status} />

      <dl className="etf-radar-kpis etf-card-wide" aria-label="상장좌수 요약">
        <div className="etf-summary-cell">
          <dt>현재 상장좌수</dt>
          <dd>{formatSharesCount(latest.listedShares)}</dd>
          <dd className="etf-summary-sub">
            <span data-direction={flowDirectionOf(lastPoint.shareDelta)}>
              전일 대비 {formatSharesCount(lastPoint.shareDelta, true)} ({formatSignedPercent(daySharePct)})
            </span>
          </dd>
        </div>
        <div className="etf-summary-cell">
          <dt>순자산총액 (AUM)</dt>
          <dd>{formatAumWon(latest.aumWon)}</dd>
          <dd className="etf-summary-sub">
            NAV {Math.round(latest.nav).toLocaleString("ko-KR")}원 · 괴리율{" "}
            {formatPremiumBps(latest.premiumBps)}
          </dd>
        </div>
        <div className="etf-summary-cell">
          <dt>5일 누적 순유입</dt>
          <dd className="etf-flow-kpi" data-direction={flowDirectionOf(latest.netFlow5dWon)}>
            {formatFlowWon(latest.netFlow5dWon, true)}
          </dd>
          <dd className="etf-summary-sub">
            좌수 {formatSignedPercent(latest.shareChange5dPct)}
            {Math.abs(latest.streakDays) >= 2
              ? ` · ${latest.streakDays > 0 ? `▲${latest.streakDays}일 연속` : `▼${Math.abs(latest.streakDays)}일 연속`}`
              : ""}
          </dd>
        </div>
        <div className="etf-summary-cell">
          <dt>20일 누적 순유입</dt>
          <dd className="etf-flow-kpi" data-direction={flowDirectionOf(latest.netFlow20dWon)}>
            {formatFlowWon(latest.netFlow20dWon, true)}
          </dd>
          <dd className="etf-summary-sub">좌수 {formatSignedPercent(latest.shareChange20dPct)}</dd>
        </div>
      </dl>

      <section className="etf-card etf-card-wide" aria-label="상장좌수·자금 유출입 차트">
        <div className="etf-card-head">
          <h3>
            일자별 상장좌수 · 추정 순자금 유출입
            {hasSplit && <Badge tone="warning">분할 보정 포함</Badge>}
            <HelpTip
              label="좌수·자금 차트 설명"
              text="상단은 상장좌수 및 보조 추이선, 하단은 일별 추정 순유입·순유출(Δ상장좌수 × 당일 NAV) 막대입니다."
            />
          </h3>
          <div className="etf-acc-controls">
            <div className="etf-chip-row" role="group" aria-label="보조 추이선">
              {OVERLAY_OPTIONS.map((option) => (
                <Chip
                  key={option.key}
                  pressed={overlays[option.key]}
                  onPressedChange={() => toggleOverlay(option.key)}
                >
                  <span className="etf-overlay-dot" data-tone={option.tone} aria-hidden="true" />
                  {option.label}
                </Chip>
              ))}
            </div>
            <Segmented
              label="시계열 기간"
              mode="pressed"
              size="sm"
              className="etf-acc-seg"
              options={DAYS_CHOICES}
              value={daysOption}
              onChange={(next) => setDaysOption(next)}
            />
          </div>
        </div>
        <SharesComboChart points={points} overlays={overlays} />
      </section>

      <section className="etf-card etf-card-wide" aria-label="일별 상장좌수 원장">
        <div className="etf-card-head">
          <h3>일별 상장좌수 · 자금 유출입 원장 ({points.length}영업일)</h3>
          <div className="etf-hero-actions">
            <button type="button" className="btn btn-sm" onClick={onOpenFlows}>
              전체 자금 흐름
            </button>
            {inCatalog && (
              <button type="button" className="btn btn-sm" onClick={onOpenHistory}>
                PDF 편입 변경 보기
              </button>
            )}
          </div>
        </div>
        <div className="etf-table-wrap" data-scroll="">
          <table className="etf-table" aria-label="일별 상장좌수 원장 표">
            <thead>
              <tr>
                <th scope="col">기준일</th>
                <th scope="col" className="etf-num">상장좌수</th>
                <th scope="col" className="etf-num">좌수 증감</th>
                <th scope="col" className="etf-num">추정 순유입/유출</th>
                <th scope="col" className="etf-num">구간 누적</th>
                <th scope="col" className="etf-num">순자산총액</th>
                <th scope="col" className="etf-num">NAV</th>
                <th scope="col" className="etf-num">종가 (괴리율)</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((point) => (
                <tr key={point.date} data-date={point.date}>
                  <td>
                    <span className="etf-kind-cell">
                      <span>{point.date}</span>
                      {point.splitAdjusted && <Badge tone="warning">분할보정</Badge>}
                    </span>
                  </td>
                  <td className="etf-num">{point.listedShares.toLocaleString("ko-KR")}</td>
                  <td className="etf-num" data-direction={flowDirectionOf(point.shareDelta)}>
                    {point.splitAdjusted
                      ? "분할 (0 처리)"
                      : point.shareDelta === 0
                        ? "-"
                        : `${point.shareDelta > 0 ? "+" : ""}${point.shareDelta.toLocaleString("ko-KR")}`}
                  </td>
                  <td className="etf-num" data-direction={flowDirectionOf(point.netFlowWon)}>
                    {point.splitAdjusted ? "0억" : formatFlowWon(point.netFlowWon, true)}
                  </td>
                  <td className="etf-num" data-direction={flowDirectionOf(point.cumNetFlowWon)}>
                    {formatFlowWon(point.cumNetFlowWon, true)}
                  </td>
                  <td className="etf-num">{formatAumWon(point.aumWon)}</td>
                  <td className="etf-num">{Math.round(point.nav).toLocaleString("ko-KR")}원</td>
                  <td className="etf-num">
                    {point.closePrice.toLocaleString("ko-KR")}원{" "}
                    <span className="etf-muted">({formatPremiumBps(point.premiumBps)})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
