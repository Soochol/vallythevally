import { useMemo, useRef, useState } from "react";
import type { PreMarketDaySeries } from "../../api/generated/PreMarketDaySeries";
import {
  buildChartGeometry,
  CHART_VIEW_H,
  CHART_VIEW_W,
  formatSecOfDay,
  formatShortDate,
  formatSignedPct,
  formatWon,
  MAX_COMPARE_DATES,
  nearestPointAt,
  PREMARKET_END_SEC,
  signalMeta,
  SPOOF_WATCH_START_SEC,
  valueTone,
} from "./logic";

interface OverlayChartProps {
  readonly availableDays: readonly string[];
  readonly selectedDays: readonly string[];
  readonly onToggleDay: (date: string) => void;
  readonly series: readonly PreMarketDaySeries[];
  readonly loading: boolean;
  readonly error: string | null;
}

export function OverlayChart({ availableDays, selectedDays, onToggleDay, series, loading, error }: OverlayChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverSec, setHoverSec] = useState<number | null>(null);
  const geom = useMemo(() => buildChartGeometry(series), [series]);

  const handlePointer = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const viewX = ((clientX - rect.left) / rect.width) * CHART_VIEW_W;
    setHoverSec(geom.secOfX(viewX));
  };

  const hoveredRows = useMemo(() => {
    if (hoverSec === null) return [];
    return series.map((day, idx) => ({
      date: day.date,
      idx,
      point: nearestPointAt(day.points, hoverSec),
    }));
  }, [series, hoverSec]);

  const spoofX = geom.xOf(SPOOF_WATCH_START_SEC);
  const spoofW = Math.max(0, geom.xOf(PREMARKET_END_SEC) - spoofX);
  const zeroY = geom.yOf(0);

  return (
    <div className="pm-pane" data-testid="premarket-compare-pane">
      <div className="pm-toolbar">
        <span className="pm-toolbar-title">08:30–09:00 날짜 비교</span>
        <div className="pm-chips" role="group" aria-label="비교 날짜 선택">
          {availableDays.map((date) => {
            const selectedIdx = selectedDays.indexOf(date);
            const active = selectedIdx >= 0;
            const disabled = !active && selectedDays.length >= MAX_COMPARE_DATES;
            return (
              <button
                key={date}
                type="button"
                className="pm-chip"
                data-testid={`premarket-day-chip-${date}`}
                data-date={date}
                aria-pressed={active}
                disabled={disabled}
                onClick={() => onToggleDay(date)}
              >
                {active && <span className="pm-swatch" data-series={String(selectedIdx)} aria-hidden="true" />}
                <span>{formatShortDate(date)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="pm-compare-body">
        {error !== null ? (
          <div className="pm-empty" role="alert">{error}</div>
        ) : loading && series.length === 0 ? (
          <div className="pm-empty">장전 예상체결 자료를 불러오는 중입니다</div>
        ) : availableDays.length === 0 ? (
          <div className="pm-empty">수집된 장전 예상체결 자료가 없습니다</div>
        ) : (
          <>
            <div className="pm-chart-wrap" data-testid="premarket-chart-wrap">
              <svg
                ref={svgRef}
                className="pm-chart-svg"
                data-testid="premarket-overlay-chart"
                viewBox={`0 0 ${CHART_VIEW_W} ${CHART_VIEW_H}`}
                preserveAspectRatio="none"
                role="img"
                aria-label="장전 예상체결 멀티데이 오버레이 차트"
                onPointerMove={(e) => handlePointer(e.clientX)}
                onMouseMove={(e) => handlePointer(e.clientX)}
                onPointerLeave={() => setHoverSec(null)}
                onMouseLeave={() => setHoverSec(null)}
              >
                <rect
                  className="pm-spoof-zone"
                  x={spoofX}
                  y={geom.plotTop}
                  width={spoofW}
                  height={geom.plotBottom - geom.plotTop}
                />
                {geom.yTicks.map((tick) => {
                  const y = geom.yOf(tick);
                  return (
                    <g key={tick}>
                      <line className="pm-grid-line" x1={geom.plotLeft} y1={y} x2={geom.plotRight} y2={y} />
                      <text className="pm-axis-text" x={geom.plotLeft - 6} y={y + 3} textAnchor="end">
                        {`${tick > 0 ? "+" : ""}${tick.toFixed(1)}%`}
                      </text>
                    </g>
                  );
                })}
                <line className="pm-zero-line" x1={geom.plotLeft} y1={zeroY} x2={geom.plotRight} y2={zeroY} />
                {geom.xTicks.map((sec) => {
                  const x = geom.xOf(sec);
                  return (
                    <g key={sec}>
                      <line className="pm-grid-line" x1={x} y1={geom.plotTop} x2={x} y2={geom.plotBottom} />
                      <text className="pm-axis-text" x={x} y={CHART_VIEW_H - 8} textAnchor="middle">
                        {formatSecOfDay(sec, false)}
                      </text>
                    </g>
                  );
                })}
                {series.map((day, idx) => {
                  if (day.points.length === 0) return null;
                  const pts = day.points
                    .map((p) => `${geom.xOf(p.secOfDay).toFixed(1)},${geom.yOf(p.expectedReturnPct).toFixed(1)}`)
                    .join(" ");
                  return (
                    <polyline
                      key={day.date}
                      className="pm-line"
                      data-series={String(idx)}
                      data-date={day.date}
                      points={pts}
                    />
                  );
                })}
                {hoverSec !== null && (
                  <g>
                    <line
                      className="pm-hover-line"
                      x1={geom.xOf(hoverSec)}
                      y1={geom.plotTop}
                      x2={geom.xOf(hoverSec)}
                      y2={geom.plotBottom}
                    />
                    {hoveredRows.map(({ date, idx, point }) =>
                      point === null ? null : (
                        <circle
                          key={date}
                          className="pm-dot"
                          data-series={String(idx)}
                          cx={geom.xOf(point.secOfDay)}
                          cy={geom.yOf(point.expectedReturnPct)}
                          r={3.5}
                        />
                      ),
                    )}
                  </g>
                )}
              </svg>

              {hoverSec !== null && hoveredRows.length > 0 && (
                <div className="pm-tooltip" data-testid="premarket-tooltip">
                  <div className="pm-tooltip-time">{formatSecOfDay(hoverSec)}</div>
                  {hoveredRows.map(({ date, idx, point }) => (
                    <div key={date} className="pm-tooltip-row" data-date={date}>
                      <span className="pm-swatch" data-series={String(idx)} aria-hidden="true" />
                      <span className="pm-tooltip-date">{formatShortDate(date)}</span>
                      <span className="pm-tooltip-price">{point ? `${formatWon(point.expectedPriceWon)}원` : "—"}</span>
                      <span className="pm-tooltip-pct pm-val" data-tone={valueTone(point?.expectedReturnPct)}>
                        {point ? formatSignedPct(point.expectedReturnPct) : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="pm-outcomes" data-testid="premarket-outcomes">
              {series.map((day, idx) => {
                const sig = signalMeta(day.classification);
                return (
                  <div key={day.date} className="pm-card" data-testid={`premarket-outcome-${day.date}`}>
                    <div className="pm-card-head">
                      <span className="pm-card-date">
                        <span className="pm-swatch" data-series={String(idx)} aria-hidden="true" />
                        <span>{formatShortDate(day.date)}</span>
                      </span>
                      <span className="pm-badge" data-tone={sig.tone}>{sig.label}</span>
                    </div>
                    <div className="pm-card-sub">
                      <span>막판 변동</span>
                      <span className="pm-val" data-tone={valueTone(day.lateDropPct)}>
                        {formatSignedPct(day.lateDropPct)}
                      </span>
                    </div>
                    <div className="pm-card-metrics">
                      <div className="pm-metric">
                        <span className="pm-metric-label">09:00</span>
                        <span className="pm-metric-val pm-val" data-tone={valueTone(day.return0900Pct)}>
                          {formatSignedPct(day.return0900Pct)}
                        </span>
                      </div>
                      <div className="pm-metric">
                        <span className="pm-metric-label">09:05</span>
                        <span className="pm-metric-val pm-val" data-tone={valueTone(day.return0905Pct)}>
                          {formatSignedPct(day.return0905Pct)}
                        </span>
                      </div>
                      <div className="pm-metric">
                        <span className="pm-metric-label">09:10</span>
                        <span className="pm-metric-val pm-val" data-tone={valueTone(day.return0910Pct)}>
                          {formatSignedPct(day.return0910Pct)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
