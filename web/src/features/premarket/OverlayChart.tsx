import { useId, useMemo } from "react";
import type { PreMarketDaySeries } from "../../api/generated/PreMarketDaySeries";
import {
  buildBreakoutSegments,
  buildChartGeometry,
  CHART_PANEL_GAP,
  CHART_VIEW_H,
  CHART_VIEW_W,
  classifyBreakout,
  computeHistoricalBand,
  formatSecOfDay,
  formatSignedPct,
  formatVolumeValue,
  nearestBandAt,
  pointVolumeValue,
  PREMARKET_END_SEC,
  SPOOF_WATCH_START_SEC,
  type VolumeUnit,
} from "./logic";

interface OverlayChartProps {
  readonly series: readonly PreMarketDaySeries[];
  readonly unit: VolumeUnit;
}

export function OverlayChart({ series, unit }: OverlayChartProps) {
  const gradPrefix = useId().replace(/:/g, "");
  const priceAboveGradId = `${gradPrefix}-p-above`;
  const volAboveGradId = `${gradPrefix}-v-above`;
  const belowGradId = `${gradPrefix}-below`;

  const focusSeries = series[series.length - 1] ?? null;
  const pastSeries = useMemo(
    () => (focusSeries ? series.slice(0, series.length - 1) : []),
    [series, focusSeries],
  );
  const populatedPastCount = useMemo(
    () => pastSeries.filter((day) => day.points.length > 0).length,
    [pastSeries],
  );

  const historicalBand = useMemo(
    () => computeHistoricalBand(pastSeries, unit),
    [pastSeries, unit],
  );

  const geom = useMemo(
    () => buildChartGeometry(series, focusSeries, historicalBand, unit),
    [series, focusSeries, historicalBand, unit],
  );

  const priceSegments = useMemo(
    () =>
      focusSeries
        ? buildBreakoutSegments(
            focusSeries.points,
            historicalBand,
            (pt) => pt.expectedReturnPct,
            (bp) => bp.minPct,
            (bp) => bp.maxPct,
            geom.xOf,
            geom.yOf,
          )
        : [],
    [focusSeries, historicalBand, geom],
  );

  const volSegments = useMemo(
    () =>
      focusSeries
        ? buildBreakoutSegments(
            focusSeries.points,
            historicalBand,
            (pt) => pointVolumeValue(pt, unit),
            (bp) => bp.minVol,
            (bp) => bp.maxVol,
            geom.xOf,
            geom.yVolOf,
          )
        : [],
    [focusSeries, historicalBand, unit, geom],
  );

  const priceBandPolys = useMemo(() => {
    if (historicalBand.length < 2) return null;
    const outer = historicalBand
      .map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yOf(b.maxPct).toFixed(1)}`)
      .concat([...historicalBand].reverse().map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yOf(b.minPct).toFixed(1)}`))
      .join(" ");
    const inner = historicalBand
      .map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yOf(b.p75Pct).toFixed(1)}`)
      .concat([...historicalBand].reverse().map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yOf(b.p25Pct).toFixed(1)}`))
      .join(" ");
    const median = historicalBand
      .map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yOf(b.medianPct).toFixed(1)}`)
      .join(" ");
    const ceiling = historicalBand
      .map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yOf(b.maxPct).toFixed(1)}`)
      .join(" ");
    const floor = historicalBand
      .map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yOf(b.minPct).toFixed(1)}`)
      .join(" ");
    return { outer, inner, median, ceiling, floor };
  }, [historicalBand, geom]);

  const volBandPolys = useMemo(() => {
    if (historicalBand.length < 2) return null;
    const outer = historicalBand
      .map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yVolOf(b.maxVol).toFixed(1)}`)
      .concat([...historicalBand].reverse().map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yVolOf(b.minVol).toFixed(1)}`))
      .join(" ");
    const inner = historicalBand
      .map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yVolOf(b.p75Vol).toFixed(1)}`)
      .concat([...historicalBand].reverse().map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yVolOf(b.p25Vol).toFixed(1)}`))
      .join(" ");
    const median = historicalBand
      .map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yVolOf(b.medianVol).toFixed(1)}`)
      .join(" ");
    const ceiling = historicalBand
      .map((b) => `${geom.xOf(b.secOfDay).toFixed(1)},${geom.yVolOf(b.maxVol).toFixed(1)}`)
      .join(" ");
    return { outer, inner, median, ceiling };
  }, [historicalBand, geom]);

  const volBasePoly = useMemo(() => {
    if (!focusSeries || focusSeries.points.length < 2) return null;
    const pts = focusSeries.points;
    const top = pts
      .map((p) => `${geom.xOf(p.secOfDay).toFixed(1)},${geom.yVolOf(pointVolumeValue(p, unit)).toFixed(1)}`)
      .join(" ");
    const firstX = geom.xOf(pts[0]!.secOfDay).toFixed(1);
    const lastX = geom.xOf(pts[pts.length - 1]!.secOfDay).toFixed(1);
    const botY = geom.plotBottom.toFixed(1);
    return `${firstX},${botY} ${top} ${lastX},${botY}`;
  }, [focusSeries, geom, unit]);

  const isFocusWaiting = focusSeries !== null && focusSeries.source === "flow" && focusSeries.points.length === 0;
  const isFocusLive = focusSeries !== null && focusSeries.source === "flow" && focusSeries.points.length > 0;
  const lastFocusPt = focusSeries && focusSeries.points.length > 0 ? focusSeries.points[focusSeries.points.length - 1]! : null;
  const lastBand = lastFocusPt ? nearestBandAt(historicalBand, lastFocusPt.secOfDay) : null;

  const priceEndState = lastFocusPt
    ? classifyBreakout(lastFocusPt.expectedReturnPct, lastBand, (bp) => bp.minPct, (bp) => bp.maxPct)
    : "solo";
  const volEndState = lastFocusPt
    ? classifyBreakout(pointVolumeValue(lastFocusPt, unit), lastBand, (bp) => bp.minVol, (bp) => bp.maxVol)
    : "solo";

  const spoofX = geom.xOf(SPOOF_WATCH_START_SEC);
  const spoofW = Math.max(0, geom.xOf(PREMARKET_END_SEC) - spoofX);
  const dividerY = geom.priceBottom + CHART_PANEL_GAP / 2;

  return (
    <div className="pm-chart-pane" data-testid="premarket-compare-pane">
      <div className="pm-chart-wrap" data-testid="premarket-chart-wrap">
        <div className="pm-svg-stage">
          <svg
            className="pm-chart-svg"
            data-testid="premarket-overlay-chart"
            viewBox={`0 0 ${CHART_VIEW_W} ${CHART_VIEW_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="장전 예상체결가 및 예상체결량 과거 범위 대비 차트"
          >
            <defs>
              <linearGradient id={priceAboveGradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className="pm-stop-price-above-top" />
                <stop offset="100%" className="pm-stop-price-above-bot" />
              </linearGradient>
              <linearGradient id={volAboveGradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className="pm-stop-vol-above-top" />
                <stop offset="100%" className="pm-stop-vol-above-bot" />
              </linearGradient>
              <linearGradient id={belowGradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className="pm-stop-below-top" />
                <stop offset="100%" className="pm-stop-below-bot" />
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

            {geom.yTicks.map((tick) => {
              const y = geom.yOf(tick);
              const isZero = tick === 0;
              return (
                <g key={tick}>
                  <line
                    className={isZero ? "pm-zero-line" : "pm-grid-line"}
                    x1={geom.plotLeft}
                    y1={y}
                    x2={geom.plotRight}
                    y2={y}
                  />
                  <text
                    className={isZero ? "pm-axis-zero" : "pm-axis-text"}
                    x={geom.plotLeft - 7}
                    y={y + 3.5}
                    textAnchor="end"
                  >
                    {`${tick > 0 ? "+" : ""}${tick.toFixed(1)}%`}
                  </text>
                </g>
              );
            })}

            {priceBandPolys !== null && (
              <g data-testid="premarket-price-band">
                <polygon className="pm-band-outer" points={priceBandPolys.outer} />
                <polygon className="pm-band-inner" points={priceBandPolys.inner} />
                <polyline className="pm-band-median" points={priceBandPolys.median} />
                <polyline className="pm-band-max" points={priceBandPolys.ceiling} />
                <polyline className="pm-band-min" points={priceBandPolys.floor} />
              </g>
            )}

            {focusSeries && priceSegments.length > 0 && (
              <g data-testid="premarket-price-series" data-date={focusSeries.date}>
                {priceSegments.map((seg) =>
                  seg.excessPoly !== null ? (
                    <polygon
                      key={`px-${seg.key}`}
                      className="pm-excess-fill"
                      data-testid={seg.state === "above" ? "premarket-price-breakout" : "premarket-price-below"}
                      data-kind="price"
                      data-state={seg.state}
                      points={seg.excessPoly}
                      fill={`url(#${seg.state === "above" ? priceAboveGradId : belowGradId})`}
                    />
                  ) : null,
                )}
                {priceSegments.map((seg) => (
                  <line
                    key={`ps-${seg.key}`}
                    className="pm-focus-seg"
                    data-kind="price"
                    data-state={seg.state}
                    x1={seg.x0}
                    y1={seg.y0}
                    x2={seg.x1}
                    y2={seg.y1}
                  />
                ))}
              </g>
            )}

            {focusSeries && lastFocusPt && (
              <g>
                {isFocusLive && (
                  <line
                    className="pm-live-guide"
                    x1={geom.xOf(lastFocusPt.secOfDay)}
                    y1={geom.plotTop}
                    x2={geom.xOf(lastFocusPt.secOfDay)}
                    y2={geom.plotBottom}
                  />
                )}
                {(isFocusLive || priceEndState === "above") && (
                  <circle
                    className="pm-end-pulse"
                    data-kind="price"
                    data-state={priceEndState}
                    cx={geom.xOf(lastFocusPt.secOfDay)}
                    cy={geom.yOf(lastFocusPt.expectedReturnPct)}
                    r={9}
                  />
                )}
                <circle
                  className="pm-focus-dot"
                  data-testid={focusSeries.points.length === 1 ? `premarket-single-point-${focusSeries.date}` : undefined}
                  data-kind="price"
                  data-state={priceEndState}
                  cx={geom.xOf(lastFocusPt.secOfDay)}
                  cy={geom.yOf(lastFocusPt.expectedReturnPct)}
                  r={4.2}
                />
                <g
                  transform={`translate(${(geom.plotRight + 5).toFixed(1)}, ${Math.max(geom.plotTop + 10, Math.min(geom.priceBottom - 10, geom.yOf(lastFocusPt.expectedReturnPct))).toFixed(1)})`}
                >
                  <rect
                    className="pm-end-pill-bg"
                    data-kind="price"
                    data-state={priceEndState}
                    x={0}
                    y={-9.5}
                    width={50}
                    height={19}
                    rx={9.5}
                  />
                  <text
                    className="pm-end-pill-text"
                    data-state={priceEndState}
                    x={25}
                    y={3.5}
                    textAnchor="middle"
                  >
                    {formatSignedPct(lastFocusPt.expectedReturnPct, 1)}
                  </text>
                </g>
              </g>
            )}

            <line
              className="pm-panel-sep"
              x1={geom.plotLeft}
              y1={dividerY}
              x2={geom.plotRight}
              y2={dividerY}
            />
            <text className="pm-panel-tag" x={geom.plotLeft + 4} y={geom.plotTop + 10}>
              예상가
            </text>
            <text className="pm-panel-tag" x={geom.plotLeft + 4} y={geom.volTop + 10}>
              예상물량
            </text>

            <line
              className="pm-grid-line"
              x1={geom.plotLeft}
              y1={geom.plotBottom}
              x2={geom.plotRight}
              y2={geom.plotBottom}
            />
            <text className="pm-axis-text" x={geom.plotLeft - 7} y={geom.volTop + 4} textAnchor="end">
              {formatVolumeValue(geom.maxVol, unit, unit === "qty")}
            </text>
            <text className="pm-axis-text" x={geom.plotLeft - 7} y={geom.plotBottom + 2} textAnchor="end">
              0
            </text>

            {volBandPolys !== null && (
              <g data-testid="premarket-vol-band">
                <polygon className="pm-band-outer" points={volBandPolys.outer} />
                <polygon className="pm-band-inner" points={volBandPolys.inner} />
                <polyline className="pm-band-median" points={volBandPolys.median} />
                <polyline className="pm-band-max" points={volBandPolys.ceiling} />
              </g>
            )}

            {focusSeries && focusSeries.points.length === 1 && lastFocusPt && (
              <rect
                className="pm-vol-single"
                data-testid="premarket-vol-series"
                data-state={volEndState}
                x={geom.xOf(lastFocusPt.secOfDay) - 5}
                y={geom.yVolOf(pointVolumeValue(lastFocusPt, unit))}
                width={10}
                height={Math.max(2, geom.plotBottom - geom.yVolOf(pointVolumeValue(lastFocusPt, unit)))}
                rx={3}
              />
            )}

            {focusSeries && volSegments.length > 0 && (
              <g data-testid="premarket-vol-series" data-date={focusSeries.date}>
                {volBasePoly !== null && <polygon className="pm-vol-base-fill" points={volBasePoly} />}
                {volSegments.map((seg) =>
                  seg.excessPoly !== null ? (
                    <polygon
                      key={`vx-${seg.key}`}
                      className="pm-excess-fill"
                      data-testid={seg.state === "above" ? "premarket-vol-breakout" : "premarket-vol-below"}
                      data-kind="vol"
                      data-state={seg.state}
                      points={seg.excessPoly}
                      fill={`url(#${seg.state === "above" ? volAboveGradId : belowGradId})`}
                    />
                  ) : null,
                )}
                {volSegments.map((seg) => (
                  <line
                    key={`vs-${seg.key}`}
                    className="pm-focus-seg"
                    data-kind="vol"
                    data-state={seg.state}
                    x1={seg.x0}
                    y1={seg.y0}
                    x2={seg.x1}
                    y2={seg.y1}
                  />
                ))}
              </g>
            )}

            {focusSeries && lastFocusPt && (
              <g>
                {(isFocusLive || volEndState === "above") && (
                  <circle
                    className="pm-end-pulse"
                    data-kind="vol"
                    data-state={volEndState}
                    cx={geom.xOf(lastFocusPt.secOfDay)}
                    cy={geom.yVolOf(pointVolumeValue(lastFocusPt, unit))}
                    r={8.5}
                  />
                )}
                <circle
                  className="pm-focus-dot"
                  data-kind="vol"
                  data-state={volEndState}
                  cx={geom.xOf(lastFocusPt.secOfDay)}
                  cy={geom.yVolOf(pointVolumeValue(lastFocusPt, unit))}
                  r={4}
                />
                <g
                  transform={`translate(${(geom.plotRight + 5).toFixed(1)}, ${Math.max(geom.volTop + 10, Math.min(geom.plotBottom - 10, geom.yVolOf(pointVolumeValue(lastFocusPt, unit)))).toFixed(1)})`}
                >
                  <rect
                    className="pm-end-pill-bg"
                    data-kind="vol"
                    data-state={volEndState}
                    x={0}
                    y={-9.5}
                    width={50}
                    height={19}
                    rx={9.5}
                  />
                  <text
                    className="pm-end-pill-text"
                    data-state={volEndState}
                    x={25}
                    y={3.5}
                    textAnchor="middle"
                  >
                    {formatVolumeValue(pointVolumeValue(lastFocusPt, unit), unit, unit === "qty")}
                  </text>
                </g>
              </g>
            )}

            {geom.xTicks.map((sec) => (
              <text
                key={sec}
                className="pm-axis-text"
                x={geom.xOf(sec)}
                y={CHART_VIEW_H - 7}
                textAnchor="middle"
              >
                {formatSecOfDay(sec, false)}
              </text>
            ))}
          </svg>

          {isFocusWaiting && populatedPastCount > 0 && (
            <div className="pm-waiting-hint" data-testid="premarket-waiting-hint">
              과거 {populatedPastCount}일 범위
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
