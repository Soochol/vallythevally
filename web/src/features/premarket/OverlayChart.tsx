import { useMemo, useRef, useState } from "react";
import type { PreMarketDaySeries } from "../../api/generated/PreMarketDaySeries";
import {
  buildChartGeometry,
  CHART_VIEW_H,
  CHART_VIEW_W,
  computeHistoricalBand,
  computePointDeltas,
  formatSecOfDay,
  formatShortDate,
  formatSignedPct,
  formatVolumeDelta,
  formatVolumeValue,
  formatWon,
  nearestBandAt,
  nearestPointAt,
  pointVolumeValue,
  PREMARKET_END_SEC,
  PREMARKET_START_SEC,
  SPOOF_WATCH_START_SEC,
  valueTone,
  type BackgroundStyle,
  type VolumeUnit,
} from "./logic";

interface OverlayChartProps {
  readonly series: readonly PreMarketDaySeries[];
  readonly focusDate: string | null;
  readonly pinnedDates: readonly string[];
  readonly spotDate: string | null;
  readonly unit: VolumeUnit;
  readonly bgStyle: BackgroundStyle;
}

export function OverlayChart({
  series,
  focusDate,
  pinnedDates,
  spotDate,
  unit,
  bgStyle,
}: OverlayChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverSec, setHoverSec] = useState<number | null>(null);

  const focusSeries = useMemo(
    () => series.find((s) => s.date === focusDate) ?? series[series.length - 1] ?? null,
    [series, focusDate],
  );

  const pinnedSeries = useMemo(() => {
    const out: PreMarketDaySeries[] = [];
    for (const date of pinnedDates) {
      if (focusSeries && date === focusSeries.date) continue;
      const found = series.find((s) => s.date === date);
      if (found) out.push(found);
    }
    return out;
  }, [series, pinnedDates, focusSeries]);

  const spotSeries = useMemo(() => {
    if (spotDate === null || (focusSeries && spotDate === focusSeries.date)) return null;
    return series.find((s) => s.date === spotDate) ?? null;
  }, [series, spotDate, focusSeries]);

  const pastSeries = useMemo(
    () => (focusSeries ? series.filter((s) => s.date !== focusSeries.date) : []),
    [series, focusSeries],
  );

  const bgOnlySeries = useMemo(() => {
    const pinnedSet = new Set(pinnedSeries.map((s) => s.date));
    return pastSeries.filter((s) => !pinnedSet.has(s.date) && (!spotSeries || s.date !== spotSeries.date));
  }, [pastSeries, pinnedSeries, spotSeries]);

  const historicalBand = useMemo(
    () => computeHistoricalBand(pastSeries, unit),
    [pastSeries, unit],
  );

  const geom = useMemo(
    () => buildChartGeometry(series, focusSeries, historicalBand, spotSeries, unit),
    [series, focusSeries, historicalBand, spotSeries, unit],
  );

  const focusDeltas = useMemo(
    () => (focusSeries ? computePointDeltas(focusSeries.points, unit) : []),
    [focusSeries, unit],
  );

  const handlePointer = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const viewX = ((clientX - rect.left) / rect.width) * CHART_VIEW_W;
    setHoverSec(geom.secOfX(viewX));
  };

  const spoofX = geom.xOf(SPOOF_WATCH_START_SEC);
  const spoofW = Math.max(0, geom.xOf(PREMARKET_END_SEC) - spoofX);
  const zeroY = geom.yOf(0);
  const unitLabel = unit === "qty" ? "예상체결량(주)" : "예상대금(억)";

  const bandPolygonPoints = useMemo(() => {
    if (bgStyle === "lines" || pastSeries.length < 2 || historicalBand.length < 2) return null;
    const upper = historicalBand.map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yOf(b.p80).toFixed(1)}`);
    const lower = [...historicalBand]
      .reverse()
      .map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yOf(b.p20).toFixed(1)}`);
    return upper.concat(lower).join(" ");
  }, [bgStyle, pastSeries.length, historicalBand, geom]);

  const medianLinePoints = useMemo(() => {
    if (bgStyle === "lines" || pastSeries.length < 2 || historicalBand.length < 2) return null;
    return historicalBand
      .map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yOf(b.median).toFixed(1)}`)
      .join(" ");
  }, [bgStyle, pastSeries.length, historicalBand, geom]);

  const volAvgLinePoints = useMemo(() => {
    if (pastSeries.length === 0 || historicalBand.length < 2) return null;
    return historicalBand
      .map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yVolOf(b.avgVolume).toFixed(1)}`)
      .join(" ");
  }, [pastSeries.length, historicalBand, geom]);

  const hoveredFocusIndex = useMemo(() => {
    if (hoverSec === null || !focusSeries || focusSeries.points.length === 0) return -1;
    const pt = nearestPointAt(focusSeries.points, hoverSec);
    if (!pt) return -1;
    return focusSeries.points.indexOf(pt);
  }, [hoverSec, focusSeries]);

  const hoveredFocusPt = hoveredFocusIndex >= 0 && focusSeries ? focusSeries.points[hoveredFocusIndex]! : null;
  const hoveredFocusDelta = hoveredFocusIndex >= 0 ? (focusDeltas[hoveredFocusIndex] ?? 0) : 0;
  const hoveredBand = hoverSec !== null ? nearestBandAt(historicalBand, hoverSec) : null;
  const hoveredPinned = useMemo(
    () =>
      hoverSec === null
        ? []
        : pinnedSeries.map((day, idx) => ({
            date: day.date,
            idx,
            point: nearestPointAt(day.points, hoverSec),
          })),
    [hoverSec, pinnedSeries],
  );

  const alignTooltipRight =
    hoverSec !== null && hoverSec < PREMARKET_START_SEC + (PREMARKET_END_SEC - PREMARKET_START_SEC) * 0.42;

  const hoverVolRatio =
    hoveredFocusPt && hoveredBand && hoveredBand.avgVolume > 0
      ? pointVolumeValue(hoveredFocusPt, unit) / hoveredBand.avgVolume
      : null;
  const hoverPctDiff =
    hoveredFocusPt && hoveredBand ? hoveredFocusPt.expectedReturnPct - hoveredBand.median : null;

  return (
    <div className="pm-chart-pane" data-testid="premarket-compare-pane">
      <div className="pm-chart-wrap" data-testid="premarket-chart-wrap">
        <div className="pm-chart-legend">
          <div className="pm-legend-group">
            {focusSeries && (
              <span className="pm-legend-item">
                <span className="pm-legend-line" data-role="focus" aria-hidden="true" />
                <strong className="pm-legend-strong">{formatShortDate(focusSeries.date)} 기준</strong>
              </span>
            )}
            {pinnedSeries.map((day, idx) => (
              <span key={day.date} className="pm-legend-item">
                <span className="pm-legend-line" data-role={`pin-${idx}`} aria-hidden="true" />
                <span>{formatShortDate(day.date)} 핀</span>
              </span>
            ))}
            {spotSeries && (
              <span className="pm-legend-item pm-legend-spot">
                <span className="pm-legend-line" data-role="spot" aria-hidden="true" />
                <span>{formatShortDate(spotSeries.date)} 스포트라이트</span>
              </span>
            )}
            {bandPolygonPoints !== null && (
              <>
                <span className="pm-legend-item">
                  <span className="pm-legend-band" aria-hidden="true" />
                  <span>{pastSeries.length}일 분포</span>
                </span>
                <span className="pm-legend-item">
                  <span className="pm-legend-dash" data-kind="median" aria-hidden="true" />
                  <span>중앙값</span>
                </span>
              </>
            )}
          </div>
          <div className="pm-legend-group">
            <span className="pm-legend-item">
              <span className="pm-legend-bar" data-delta="in" aria-hidden="true" />
              <span>유입</span>
            </span>
            <span className="pm-legend-item">
              <span className="pm-legend-bar" data-delta="out" aria-hidden="true" />
              <span>이탈(Δ-)</span>
            </span>
            {volAvgLinePoints !== null && (
              <span className="pm-legend-item">
                <span className="pm-legend-dash" data-kind="vol" aria-hidden="true" />
                <span>평균 물량</span>
              </span>
            )}
          </div>
        </div>

        <div className="pm-svg-stage">
          <svg
            ref={svgRef}
            className="pm-chart-svg"
            data-testid="premarket-overlay-chart"
            viewBox={`0 0 ${CHART_VIEW_W} ${CHART_VIEW_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="장전 예상등락률 및 예상체결량 이중 Y축 차트"
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
            <text
              className="pm-spoof-label"
              x={spoofX + spoofW / 2}
              y={geom.plotTop + 12}
              textAnchor="middle"
            >
              08:58 막판
            </text>

            {geom.yTicks.map((tick) => {
              const y = geom.yOf(tick);
              return (
                <g key={tick}>
                  <line className="pm-grid-line" x1={geom.plotLeft} y1={y} x2={geom.plotRight} y2={y} />
                  <text className="pm-axis-text" x={geom.plotLeft - 7} y={y + 3.5} textAnchor="end">
                    {`${tick > 0 ? "+" : ""}${tick.toFixed(1)}%`}
                  </text>
                </g>
              );
            })}

            <line className="pm-zero-line" x1={geom.plotLeft} y1={zeroY} x2={geom.plotRight} y2={zeroY} />

            {geom.volTicks.map((vt, idx) => {
              const y = geom.yVolOf(vt);
              return (
                <text key={idx} className="pm-axis-vol" x={geom.plotRight + 7} y={y + 3.5} textAnchor="start">
                  {formatVolumeValue(vt, unit)}
                </text>
              );
            })}
            <text className="pm-axis-vol" x={geom.plotRight + 7} y={geom.volTop - 8} textAnchor="start">
              {unitLabel}
            </text>

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

            {focusSeries?.points.map((pt, idx) => {
              const v = pointVolumeValue(pt, unit);
              const dv = focusDeltas[idx] ?? 0;
              const y = geom.yVolOf(v);
              const h = Math.max(1, geom.plotBottom - y);
              const deltaTone = dv < 0 ? "out" : dv > geom.maxVol * 0.045 ? "surge" : "in";
              return (
                <rect
                  key={`${pt.secOfDay}-${idx}`}
                  className="pm-vol-rect"
                  data-delta={deltaTone}
                  data-hover={idx === hoveredFocusIndex}
                  x={geom.xOf(pt.secOfDay) - geom.barWidth / 2}
                  y={y}
                  width={geom.barWidth}
                  height={h}
                  rx={1.5}
                />
              );
            })}

            {volAvgLinePoints !== null && (
              <polyline className="pm-vol-avg-line" points={volAvgLinePoints} />
            )}

            {spotSeries && spotSeries.points.length > 1 && (
              <polyline
                className="pm-vol-spot-line"
                points={spotSeries.points
                  .map((p) => `${geom.xOf(p.secOfDay).toFixed(1)},${geom.yVolOf(pointVolumeValue(p, unit)).toFixed(1)}`)
                  .join(" ")}
              />
            )}

            {bandPolygonPoints !== null && (
              <polygon className="pm-band-area" points={bandPolygonPoints} />
            )}
            {medianLinePoints !== null && (
              <polyline className="pm-band-median" points={medianLinePoints} />
            )}

            {bgStyle !== "band" &&
              bgOnlySeries.map((day, idx) => {
                if (day.points.length === 0) return null;
                const recency = (idx + 1) / Math.max(1, bgOnlySeries.length);
                const opacity = spotSeries ? 0.1 : Number((0.14 + recency * 0.22).toFixed(2));
                if (day.points.length === 1) {
                  const p = day.points[0]!;
                  return (
                    <circle
                      key={day.date}
                      className="pm-bg-dot"
                      data-testid={`premarket-single-point-${day.date}`}
                      data-date={day.date}
                      style={{ opacity }}
                      cx={geom.xOf(p.secOfDay)}
                      cy={geom.yOf(p.expectedReturnPct)}
                      r={3}
                    />
                  );
                }
                const pts = day.points
                  .map((p) => `${geom.xOf(p.secOfDay).toFixed(1)},${geom.yOf(p.expectedReturnPct).toFixed(1)}`)
                  .join(" ");
                return (
                  <polyline
                    key={day.date}
                    className="pm-bg-line"
                    data-date={day.date}
                    style={{ opacity }}
                    points={pts}
                  />
                );
              })}

            {pinnedSeries.map((day, idx) => {
              if (day.points.length === 0) return null;
              const opacity = spotSeries ? 0.35 : 0.92;
              if (day.points.length === 1) {
                const p = day.points[0]!;
                return (
                  <circle
                    key={day.date}
                    className="pm-pin-dot"
                    data-testid={`premarket-single-point-${day.date}`}
                    data-pin={String(idx)}
                    data-date={day.date}
                    style={{ opacity }}
                    cx={geom.xOf(p.secOfDay)}
                    cy={geom.yOf(p.expectedReturnPct)}
                    r={3.5}
                  />
                );
              }
              const pts = day.points
                .map((p) => `${geom.xOf(p.secOfDay).toFixed(1)},${geom.yOf(p.expectedReturnPct).toFixed(1)}`)
                .join(" ");
              return (
                <polyline
                  key={day.date}
                  className="pm-pin-line"
                  data-pin={String(idx)}
                  data-date={day.date}
                  style={{ opacity }}
                  points={pts}
                />
              );
            })}

            {spotSeries && spotSeries.points.length > 0 && (
              spotSeries.points.length === 1 ? (
                <circle
                  className="pm-spot-dot"
                  data-date={spotSeries.date}
                  cx={geom.xOf(spotSeries.points[0]!.secOfDay)}
                  cy={geom.yOf(spotSeries.points[0]!.expectedReturnPct)}
                  r={4.2}
                />
              ) : (
                <polyline
                  className="pm-spot-line"
                  data-date={spotSeries.date}
                  points={spotSeries.points
                    .map((p) => `${geom.xOf(p.secOfDay).toFixed(1)},${geom.yOf(p.expectedReturnPct).toFixed(1)}`)
                    .join(" ")}
                />
              )
            )}

            {focusSeries && focusSeries.points.length > 0 && (
              focusSeries.points.length === 1 ? (
                <circle
                  className="pm-focus-dot"
                  data-testid={`premarket-single-point-${focusSeries.date}`}
                  data-date={focusSeries.date}
                  cx={geom.xOf(focusSeries.points[0]!.secOfDay)}
                  cy={geom.yOf(focusSeries.points[0]!.expectedReturnPct)}
                  r={4.2}
                />
              ) : (
                <g>
                  <polyline
                    className="pm-focus-line"
                    data-date={focusSeries.date}
                    points={focusSeries.points
                      .map((p) => `${geom.xOf(p.secOfDay).toFixed(1)},${geom.yOf(p.expectedReturnPct).toFixed(1)}`)
                      .join(" ")}
                  />
                  <circle
                    className="pm-focus-dot"
                    cx={geom.xOf(focusSeries.points[focusSeries.points.length - 1]!.secOfDay)}
                    cy={geom.yOf(focusSeries.points[focusSeries.points.length - 1]!.expectedReturnPct)}
                    r={4}
                  />
                </g>
              )
            )}

            {hoverSec !== null && (
              <g>
                <line
                  className="pm-hover-line"
                  x1={geom.xOf(hoverSec)}
                  y1={geom.plotTop}
                  x2={geom.xOf(hoverSec)}
                  y2={geom.plotBottom}
                />
                {hoveredFocusPt && (
                  <circle
                    className="pm-focus-dot"
                    cx={geom.xOf(hoveredFocusPt.secOfDay)}
                    cy={geom.yOf(hoveredFocusPt.expectedReturnPct)}
                    r={4.6}
                  />
                )}
                {hoveredPinned.map(({ date, idx, point }) =>
                  point === null ? null : (
                    <circle
                      key={date}
                      className="pm-pin-dot"
                      data-pin={String(idx)}
                      cx={geom.xOf(point.secOfDay)}
                      cy={geom.yOf(point.expectedReturnPct)}
                      r={3.6}
                    />
                  ),
                )}
              </g>
            )}
          </svg>

          {hoverSec !== null && focusSeries && (
            <div
              className="pm-tooltip"
              data-testid="premarket-tooltip"
              data-align={alignTooltipRight ? "right" : "left"}
            >
              <div className="pm-tooltip-head">
                <span className="pm-tooltip-time">{formatSecOfDay(hoverSec)}</span>
                {hoverSec >= SPOOF_WATCH_START_SEC && (
                  <span className="pm-tooltip-zone">08:58 막판 구간</span>
                )}
              </div>

              <div className="pm-tooltip-row" data-role="focus" data-date={focusSeries.date}>
                <span className="pm-day-dot" data-role="focus" aria-hidden="true" />
                <span className="pm-tooltip-date">{formatShortDate(focusSeries.date)}★</span>
                <span className="pm-tooltip-pct pm-val" data-tone={valueTone(hoveredFocusPt?.expectedReturnPct)}>
                  {hoveredFocusPt ? formatSignedPct(hoveredFocusPt.expectedReturnPct) : "—"}
                </span>
                <span className="pm-tooltip-vol">
                  {hoveredFocusPt ? formatVolumeValue(pointVolumeValue(hoveredFocusPt, unit), unit) : "—"}
                </span>
                <span className="pm-tooltip-price">
                  {hoveredFocusPt ? `${formatWon(hoveredFocusPt.expectedPriceWon)}원` : "—"}
                </span>
              </div>

              {hoveredPinned.map(({ date, idx, point }) => (
                <div key={date} className="pm-tooltip-row" data-role={`pin-${idx}`} data-date={date}>
                  <span className="pm-day-dot" data-role={`pin-${idx}`} aria-hidden="true" />
                  <span className="pm-tooltip-date">{formatShortDate(date)}</span>
                  <span className="pm-tooltip-pct pm-val" data-tone={valueTone(point?.expectedReturnPct)}>
                    {point ? formatSignedPct(point.expectedReturnPct) : "—"}
                  </span>
                  <span className="pm-tooltip-vol">
                    {point ? formatVolumeValue(pointVolumeValue(point, unit), unit) : "—"}
                  </span>
                  <span className="pm-tooltip-price">
                    {point ? `${formatWon(point.expectedPriceWon)}원` : "—"}
                  </span>
                </div>
              ))}

              <div className="pm-tooltip-summary">
                <div className="pm-tooltip-stat">
                  <span className="pm-tooltip-stat-label">직전 대비 물량 Δ</span>
                  <span className="pm-val" data-tone={hoveredFocusDelta > 0 ? "accent" : hoveredFocusDelta < 0 ? "warn" : "flat"}>
                    {hoveredFocusPt ? formatVolumeDelta(hoveredFocusDelta, unit) : "—"}
                  </span>
                </div>
                {hoveredBand && pastSeries.length > 0 && (
                  <>
                    <div className="pm-tooltip-stat">
                      <span className="pm-tooltip-stat-label">과거 {pastSeries.length}일 평균 물량</span>
                      <span className="pm-tooltip-stat-val">
                        {formatVolumeValue(hoveredBand.avgVolume, unit)}
                        {hoverVolRatio !== null && (
                          <span
                            className="pm-val"
                            data-tone={hoverVolRatio >= 1.5 ? "accent" : hoverVolRatio <= 0.75 ? "warn" : "flat"}
                          >
                            {` (×${hoverVolRatio.toFixed(1)})`}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="pm-tooltip-stat">
                      <span className="pm-tooltip-stat-label">과거 {pastSeries.length}일 중앙값</span>
                      <span className="pm-tooltip-stat-val">
                        {formatSignedPct(hoveredBand.median)}
                        {hoverPctDiff !== null && (
                          <span className="pm-val" data-tone={valueTone(hoverPctDiff)}>
                            {` (${hoverPctDiff >= 0 ? "+" : ""}${hoverPctDiff.toFixed(2)}%p)`}
                          </span>
                        )}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
