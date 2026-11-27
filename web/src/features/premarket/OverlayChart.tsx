import { useId, useMemo, useRef, useState } from "react";
import type { PreMarketDaySeries } from "../../api/generated/PreMarketDaySeries";
import {
  buildChartGeometry,
  CHART_VIEW_H,
  CHART_VIEW_W,
  computeHistoricalBand,
  computePointDeltas,
  formatKoreanWeekday,
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
  const gradPrefix = useId().replace(/:/g, "");
  const volAreaGradId = `${gradPrefix}-vol-area`;
  const volDropGradId = `${gradPrefix}-vol-drop`;
  const volSpotGradId = `${gradPrefix}-vol-spot`;
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
    () => buildChartGeometry(series, focusSeries, historicalBand, spotSeries, unit, pinnedSeries),
    [series, focusSeries, historicalBand, spotSeries, unit, pinnedSeries],
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
  const isFocusWaiting = focusSeries !== null && focusSeries.source === "flow" && focusSeries.points.length === 0;
  const isFocusLive = focusSeries !== null && focusSeries.source === "flow" && focusSeries.points.length > 0;
  const lastFocusPt = focusSeries && focusSeries.points.length > 0 ? focusSeries.points[focusSeries.points.length - 1]! : null;

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

  const focusVolArea = useMemo(() => {
    if (!focusSeries || focusSeries.points.length < 2) return null;
    const pts = focusSeries.points;
    const topPts = pts.map((p) => `${geom.xOf(p.secOfDay).toFixed(1)},${geom.yVolOf(pointVolumeValue(p, unit)).toFixed(1)}`);
    const firstX = geom.xOf(pts[0]!.secOfDay).toFixed(1);
    const lastX = geom.xOf(pts[pts.length - 1]!.secOfDay).toFixed(1);
    const botY = geom.plotBottom.toFixed(1);
    const dropSegments: { readonly key: string; readonly poly: string; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }[] = [];
    for (let i = 1; i < pts.length; i++) {
      if ((focusDeltas[i] ?? 0) < 0) {
        const pPrev = pts[i - 1]!;
        const pCurr = pts[i]!;
        const x0 = geom.xOf(pPrev.secOfDay);
        const y0 = geom.yVolOf(pointVolumeValue(pPrev, unit));
        const x1 = geom.xOf(pCurr.secOfDay);
        const y1 = geom.yVolOf(pointVolumeValue(pCurr, unit));
        dropSegments.push({
          key: `${pPrev.secOfDay}-${pCurr.secOfDay}`,
          poly: `${x0.toFixed(1)},${botY} ${x0.toFixed(1)},${y0.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${botY}`,
          x0,
          y0,
          x1,
          y1,
        });
      }
    }
    return {
      poly: `${firstX},${botY} ${topPts.join(" ")} ${lastX},${botY}`,
      contour: topPts.join(" "),
      dropSegments,
    };
  }, [focusSeries, focusDeltas, geom, unit]);

  const spotVolArea = useMemo(() => {
    if (!spotSeries || spotSeries.points.length < 2) return null;
    const pts = spotSeries.points;
    const topPts = pts.map((p) => `${geom.xOf(p.secOfDay).toFixed(1)},${geom.yVolOf(pointVolumeValue(p, unit)).toFixed(1)}`);
    const firstX = geom.xOf(pts[0]!.secOfDay).toFixed(1);
    const lastX = geom.xOf(pts[pts.length - 1]!.secOfDay).toFixed(1);
    const botY = geom.plotBottom.toFixed(1);
    return {
      poly: `${firstX},${botY} ${topPts.join(" ")} ${lastX},${botY}`,
      contour: topPts.join(" "),
    };
  }, [spotSeries, geom, unit]);

  const hoveredFocusIndex = useMemo(() => {
    if (hoverSec === null || !focusSeries || focusSeries.points.length === 0) return -1;
    const lastSec = focusSeries.points[focusSeries.points.length - 1]!.secOfDay;
    if (isFocusLive && hoverSec > lastSec) return -1;
    const pt = nearestPointAt(focusSeries.points, hoverSec);
    if (!pt) return -1;
    return focusSeries.points.indexOf(pt);
  }, [hoverSec, focusSeries, isFocusLive]);

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
    hoverSec !== null && hoverSec < geom.startSec + (PREMARKET_END_SEC - geom.startSec) * 0.42;

  const hoverVolRatio =
    hoveredFocusPt && hoveredBand && hoveredBand.avgVolume > 0
      ? pointVolumeValue(hoveredFocusPt, unit) / hoveredBand.avgVolume
      : null;
  const hoverPctDiff =
    hoveredFocusPt && hoveredBand ? hoveredFocusPt.expectedReturnPct - hoveredBand.median : null;

  const endPillPos = useMemo(() => {
    if (!lastFocusPt) return null;
    const lx = geom.xOf(lastFocusPt.secOfDay);
    const ly = geom.yOf(lastFocusPt.expectedReturnPct);
    const pillX = Math.min(geom.plotRight - 52, lx + 8);
    const pillY = Math.max(geom.plotTop + 12, Math.min(geom.priceBottom - 12, ly));
    return { lx, ly, pillX, pillY };
  }, [lastFocusPt, geom]);

  return (
    <div className="pm-chart-pane" data-testid="premarket-compare-pane">
      <div className="pm-chart-wrap" data-testid="premarket-chart-wrap">
        <div className="pm-chart-legend">
          <div className="pm-legend-group">
            {focusSeries && (
              <span className="pm-legend-item">
                <span className="pm-legend-line" data-role={isFocusWaiting ? "wait" : "focus"} aria-hidden="true" />
                <strong className="pm-legend-strong">
                  {formatShortDate(focusSeries.date)} {isFocusWaiting ? "대기" : isFocusLive ? "실시간" : "기준"}
                </strong>
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
              <span className="pm-legend-area" data-delta="in" aria-hidden="true" />
              <span>{unit === "qty" ? "예상체결량(면)" : "예상대금(면)"}</span>
            </span>
            <span className="pm-legend-item">
              <span className="pm-legend-area" data-delta="out" aria-hidden="true" />
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
            <defs>
              <linearGradient id={volAreaGradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className="pm-stop-vol-top" />
                <stop offset="100%" className="pm-stop-vol-bot" />
              </linearGradient>
              <linearGradient id={volDropGradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className="pm-stop-drop-top" />
                <stop offset="100%" className="pm-stop-drop-bot" />
              </linearGradient>
              <linearGradient id={volSpotGradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className="pm-stop-spot-top" />
                <stop offset="100%" className="pm-stop-spot-bot" />
              </linearGradient>
            </defs>

            <rect
              className="pm-spoof-zone"
              x={spoofX}
              y={geom.plotTop}
              width={spoofW}
              height={geom.plotBottom - geom.plotTop}
            />
            <line
              className="pm-spoof-border"
              x1={spoofX}
              y1={geom.plotTop}
              x2={spoofX}
              y2={geom.plotBottom}
            />
            <text
              className="pm-spoof-label"
              x={spoofX + spoofW / 2}
              y={geom.plotTop + 12}
              textAnchor="middle"
            >
              막판 2분
            </text>

            <line
              className="pm-vol-sep"
              x1={geom.plotLeft}
              y1={geom.volTop - 8}
              x2={geom.plotRight}
              y2={geom.volTop - 8}
            />

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

            {focusSeries && focusSeries.points.length === 1 && (
              <rect
                className="pm-vol-single"
                data-testid="premarket-vol-area"
                x={geom.xOf(focusSeries.points[0]!.secOfDay) - 5}
                y={geom.yVolOf(pointVolumeValue(focusSeries.points[0]!, unit))}
                width={10}
                height={Math.max(2, geom.plotBottom - geom.yVolOf(pointVolumeValue(focusSeries.points[0]!, unit)))}
                rx={3}
                fill={`url(#${volAreaGradId})`}
              />
            )}

            {focusVolArea !== null && (
              <g data-testid="premarket-vol-area">
                <polygon points={focusVolArea.poly} fill={`url(#${volAreaGradId})`} />
                <polyline className="pm-vol-contour" points={focusVolArea.contour} />
                {focusVolArea.dropSegments.map((seg) => (
                  <g key={seg.key}>
                    <polygon points={seg.poly} fill={`url(#${volDropGradId})`} />
                    <line className="pm-vol-drop-edge" x1={seg.x0} y1={seg.y0} x2={seg.x1} y2={seg.y1} />
                  </g>
                ))}
              </g>
            )}

            {volAvgLinePoints !== null && (
              <polyline className="pm-vol-avg-line" points={volAvgLinePoints} />
            )}

            {pinnedSeries.map((day, idx) => {
              if (day.points.length < 2) return null;
              const opacity = spotSeries ? 0.35 : 0.88;
              const pts = day.points
                .map((p) => `${geom.xOf(p.secOfDay).toFixed(1)},${geom.yVolOf(pointVolumeValue(p, unit)).toFixed(1)}`)
                .join(" ");
              return (
                <polyline
                  key={`vol-pin-${day.date}`}
                  className="pm-vol-pin-line"
                  data-pin={String(idx)}
                  data-date={day.date}
                  style={{ opacity }}
                  points={pts}
                />
              );
            })}

            {spotVolArea !== null && spotSeries && (
              <g>
                <polygon points={spotVolArea.poly} fill={`url(#${volSpotGradId})`} />
                <polyline
                  className="pm-vol-spot-line"
                  data-date={spotSeries.date}
                  points={spotVolArea.contour}
                />
              </g>
            )}

            {bandPolygonPoints !== null && (
              <polygon className="pm-band-area" points={bandPolygonPoints} />
            )}
            {medianLinePoints !== null && (
              <polyline className="pm-band-median" points={medianLinePoints} />
            )}

            {(bgStyle !== "band" || pastSeries.length < 2) &&
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

            {focusSeries && lastFocusPt && endPillPos && (
              <g>
                {focusSeries.points.length > 1 && (
                  <polyline
                    className="pm-focus-line"
                    data-date={focusSeries.date}
                    points={focusSeries.points
                      .map((p) => `${geom.xOf(p.secOfDay).toFixed(1)},${geom.yOf(p.expectedReturnPct).toFixed(1)}`)
                      .join(" ")}
                  />
                )}
                {isFocusLive && (
                  <>
                    <line
                      className="pm-live-guide"
                      x1={endPillPos.lx}
                      y1={geom.plotTop}
                      x2={endPillPos.lx}
                      y2={geom.plotBottom}
                    />
                    <circle className="pm-live-pulse" cx={endPillPos.lx} cy={endPillPos.ly} r={8.5} />
                  </>
                )}
                <circle
                  className="pm-focus-dot"
                  data-testid={focusSeries.points.length === 1 ? `premarket-single-point-${focusSeries.date}` : undefined}
                  data-date={focusSeries.date}
                  cx={endPillPos.lx}
                  cy={endPillPos.ly}
                  r={4.3}
                />
                <g transform={`translate(${endPillPos.pillX.toFixed(1)}, ${endPillPos.pillY.toFixed(1)})`}>
                  <rect className="pm-end-pill-bg" x={0} y={-9.5} width={48} height={19} rx={9.5} />
                  <text className="pm-end-pill-text" x={24} y={3.5} textAnchor="middle">
                    {formatSignedPct(lastFocusPt.expectedReturnPct, 1)}
                  </text>
                </g>
              </g>
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
                  <>
                    <circle
                      className="pm-focus-dot"
                      cx={geom.xOf(hoveredFocusPt.secOfDay)}
                      cy={geom.yOf(hoveredFocusPt.expectedReturnPct)}
                      r={4.6}
                    />
                    <circle
                      className="pm-vol-hover-dot"
                      data-delta={hoveredFocusDelta < 0 ? "out" : "in"}
                      cx={geom.xOf(hoveredFocusPt.secOfDay)}
                      cy={geom.yVolOf(pointVolumeValue(hoveredFocusPt, unit))}
                      r={3.8}
                    />
                  </>
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

          {isFocusWaiting && focusSeries && (
            <div className="pm-waiting-pill" data-testid="premarket-waiting-pill">
              <span className="pm-live-dot" aria-hidden="true" />
              <strong className="pm-waiting-strong">
                {formatShortDate(focusSeries.date)}({formatKoreanWeekday(focusSeries.date)}) 08:50 예상체결 대기 중
              </strong>
              {pastSeries.length > 0 && <span>· 과거 {pastSeries.length}일 분포 기준</span>}
            </div>
          )}

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
                <span className="pm-day-dot" data-role={isFocusWaiting ? "wait" : "focus"} aria-hidden="true" />
                <span className="pm-tooltip-date">{formatShortDate(focusSeries.date)}★</span>
                {hoveredFocusPt ? (
                  <>
                    <span className="pm-tooltip-pct pm-val" data-tone={valueTone(hoveredFocusPt.expectedReturnPct)}>
                      {formatSignedPct(hoveredFocusPt.expectedReturnPct)}
                    </span>
                    <span className="pm-tooltip-vol">
                      {formatVolumeValue(pointVolumeValue(hoveredFocusPt, unit), unit)}
                    </span>
                    <span className="pm-tooltip-price">{formatWon(hoveredFocusPt.expectedPriceWon)}원</span>
                  </>
                ) : (
                  <span className="pm-tooltip-wait">
                    {isFocusWaiting ? "08:50 예상체결 대기 중" : "미도래 시각"}
                  </span>
                )}
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
                {hoveredFocusPt && (
                  <div className="pm-tooltip-stat">
                    <span className="pm-tooltip-stat-label">직전 대비 물량 Δ</span>
                    <span
                      className="pm-val"
                      data-tone={hoveredFocusDelta > 0 ? "accent" : hoveredFocusDelta < 0 ? "warn" : "flat"}
                    >
                      {formatVolumeDelta(hoveredFocusDelta, unit)}
                    </span>
                  </div>
                )}
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
