import { useMemo, useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { usePreMarketCompare, usePreMarketDays } from "../../api/premarket";
import { useSymbolInfo } from "../../api/queries";
import type { WindowId } from "../../layout/kinds";
import { isIndexCode } from "../../lib/symbol";
import { useLinkedSymbol } from "../market-window/MarketWindowGate";
import { useWindowVisible } from "../workspace/windowVisibility";
import { DateListPane } from "./DateListPane";
import {
  computeHistoricalBand,
  formatKoreanWeekday,
  formatSecOfDay,
  formatShortDate,
  formatSignedPct,
  formatVolumeValue,
  formatWon,
  nearestBandAt,
  pointVolumeValue,
  selectRangeDates,
  signalMeta,
  togglePinnedDate,
  valueTone,
  type BackgroundStyle,
  type CompareRange,
  type VolumeUnit,
} from "./logic";
import { OverlayChart } from "./OverlayChart";
import "./premarket.css";

export function PreMarketWindow({ id }: { id: WindowId }) {
  const linkedSymbol = useLinkedSymbol(id);
  const stockSymbol = linkedSymbol !== null && !isIndexCode(linkedSymbol) ? linkedSymbol : null;
  const symbolInfo = useSymbolInfo(stockSymbol);

  const [range, setRange] = useState<CompareRange>(10);
  const [unit, setUnit] = useState<VolumeUnit>("qty");
  const [bgStyle, setBgStyle] = useState<BackgroundStyle>("both");
  const [focusBySymbol, setFocusBySymbol] = useState<{ readonly symbol: SymbolCode; readonly date: string } | null>(null);
  const [pinnedBySymbol, setPinnedBySymbol] = useState<{ readonly symbol: SymbolCode; readonly dates: readonly string[] } | null>(null);
  const [spotDate, setSpotDate] = useState<string | null>(null);

  const windowVisible = useWindowVisible();
  const daysQuery = usePreMarketDays(stockSymbol, windowVisible);
  const availableDays = daysQuery.data?.days ?? [];

  const rangeDates = useMemo(
    () => (stockSymbol === null ? [] : selectRangeDates(availableDays, range)),
    [stockSymbol, availableDays, range],
  );

  const compareQuery = usePreMarketCompare(stockSymbol, rangeDates, windowVisible);
  const series = compareQuery.data?.series ?? [];

  const focusDate = useMemo(() => {
    if (rangeDates.length === 0) return null;
    if (focusBySymbol !== null && focusBySymbol.symbol === stockSymbol && rangeDates.includes(focusBySymbol.date)) {
      return focusBySymbol.date;
    }
    return rangeDates[rangeDates.length - 1] ?? null;
  }, [rangeDates, focusBySymbol, stockSymbol]);

  const pinnedDates = useMemo(() => {
    if (stockSymbol === null || rangeDates.length === 0) return [];
    if (pinnedBySymbol !== null && pinnedBySymbol.symbol === stockSymbol) {
      return pinnedBySymbol.dates.filter((d) => d !== focusDate && rangeDates.includes(d));
    }
    return [];
  }, [stockSymbol, rangeDates, pinnedBySymbol, focusDate]);

  const focusSeries = useMemo(
    () => series.find((s) => s.date === focusDate) ?? series[series.length - 1] ?? null,
    [series, focusDate],
  );

  const pastSeries = useMemo(
    () => (focusSeries ? series.filter((s) => s.date !== focusSeries.date) : []),
    [series, focusSeries],
  );

  const historicalBand = useMemo(
    () => computeHistoricalBand(pastSeries, unit),
    [pastSeries, unit],
  );

  const lastFocusPt = focusSeries?.points[focusSeries.points.length - 1] ?? null;
  const lastBand = lastFocusPt
    ? nearestBandAt(historicalBand, lastFocusPt.secOfDay)
    : (historicalBand[historicalBand.length - 1] ?? null);
  const volRatio =
    lastFocusPt && lastBand && lastBand.avgVolume > 0
      ? pointVolumeValue(lastFocusPt, unit) / lastBand.avgVolume
      : null;

  const handleTogglePin = (date: string) => {
    if (stockSymbol === null) return;
    setPinnedBySymbol({
      symbol: stockSymbol,
      dates: togglePinnedDate(pinnedDates, date, focusDate),
    });
  };

  const handleSelectFocus = (date: string) => {
    if (stockSymbol === null) return;
    setFocusBySymbol({ symbol: stockSymbol, date });
    setPinnedBySymbol({
      symbol: stockSymbol,
      dates: pinnedDates.filter((d) => d !== date),
    });
    setSpotDate(null);
  };

  const error = daysQuery.error?.message ?? compareQuery.error?.message ?? null;
  const loading = daysQuery.isLoading || compareQuery.isLoading;
  const focusSignal = focusSeries ? signalMeta(focusSeries.classification) : null;
  const isFocusPending = focusSeries !== null && focusSeries.source === "flow" && lastFocusPt === null;
  const isFocusLive = focusSeries !== null && focusSeries.source === "flow" && lastFocusPt !== null;

  return (
    <div
      className="pm"
      data-testid="premarket-window"
      data-symbol={stockSymbol ?? ""}
    >
      <div className="pm-head">
        <div className="pm-head-left">
          <div className="pm-sym">
            <span className="pm-sym-name">
              {stockSymbol !== null ? (symbolInfo.data?.name ?? stockSymbol) : "종목 미선택"}
            </span>
            {stockSymbol !== null && <span className="pm-sym-code">{stockSymbol}</span>}
          </div>

          {focusSeries && lastFocusPt ? (
            <div className="pm-head-metrics" data-testid="premarket-head-metrics">
              <span className="pm-hero-price">
                <span className="pm-hero-pct pm-val" data-tone={valueTone(lastFocusPt.expectedReturnPct)}>
                  {formatSignedPct(lastFocusPt.expectedReturnPct)}
                </span>
                <span className="pm-hero-won">{formatWon(lastFocusPt.expectedPriceWon)}원</span>
                <span className="pm-head-date-tag">{formatShortDate(focusSeries.date)} 예상가</span>
              </span>
              <span className="pm-hero-vol">
                <span className="pm-head-label">예상물량</span>
                <span className="pm-head-val pm-val" data-tone="accent">
                  {formatVolumeValue(pointVolumeValue(lastFocusPt, unit), unit)}
                </span>
                {volRatio !== null && (
                  <span
                    className="pm-head-ratio pm-val"
                    data-tone={volRatio >= 1.5 ? "accent" : volRatio <= 0.75 ? "warn" : "flat"}
                  >
                    (×{volRatio.toFixed(1)})
                  </span>
                )}
              </span>
              {isFocusLive ? (
                <span className="pm-badge" data-tone="live">
                  <span className="pm-live-dot" aria-hidden="true" />
                  <span>실시간 {formatSecOfDay(lastFocusPt.secOfDay, false)}</span>
                </span>
              ) : (
                focusSignal && (
                  <span className="pm-badge" data-tone={focusSignal.tone}>
                    {focusSignal.label}
                  </span>
                )
              )}
            </div>
          ) : isFocusPending && focusSeries ? (
            <div className="pm-head-metrics" data-testid="premarket-head-metrics">
              <span className="pm-hero-price">
                <span className="pm-head-date-tag">
                  {formatShortDate(focusSeries.date)}({formatKoreanWeekday(focusSeries.date)})
                </span>
              </span>
              {lastBand && (
                <span className="pm-hero-vol">
                  <span className="pm-head-label">{pastSeries.length}일 마감 평균</span>
                  <span className="pm-head-val">{formatVolumeValue(lastBand.avgVolume, unit)}</span>
                </span>
              )}
              <span className="pm-badge" data-tone="ext" data-testid="premarket-pending-badge">
                <span className="pm-live-dot" aria-hidden="true" />
                <span>08:30 대기 중</span>
              </span>
            </div>
          ) : null}
        </div>

        {stockSymbol !== null && (
          <div className="pm-head-controls">
            <div className="pm-ctrl-group" role="group" aria-label="비교 기간">
              <button
                type="button"
                className="pm-seg-btn"
                data-testid="premarket-range-5"
                aria-pressed={range === 5}
                onClick={() => setRange(5)}
              >
                5일
              </button>
              <button
                type="button"
                className="pm-seg-btn"
                data-testid="premarket-range-10"
                aria-pressed={range === 10}
                onClick={() => setRange(10)}
              >
                2주
              </button>
            </div>

            <div className="pm-ctrl-group" role="group" aria-label="과거일 표시">
              <button
                type="button"
                className="pm-seg-btn"
                data-testid="premarket-bg-both"
                aria-pressed={bgStyle === "both"}
                onClick={() => setBgStyle("both")}
              >
                선+밴드
              </button>
              <button
                type="button"
                className="pm-seg-btn"
                data-testid="premarket-bg-band"
                aria-pressed={bgStyle === "band"}
                onClick={() => setBgStyle("band")}
              >
                밴드만
              </button>
              <button
                type="button"
                className="pm-seg-btn"
                data-testid="premarket-bg-lines"
                aria-pressed={bgStyle === "lines"}
                onClick={() => setBgStyle("lines")}
              >
                선만
              </button>
            </div>

            <div className="pm-ctrl-group" role="group" aria-label="물량 단위">
              <button
                type="button"
                className="pm-seg-btn"
                data-testid="premarket-unit-qty"
                aria-pressed={unit === "qty"}
                onClick={() => setUnit("qty")}
              >
                주
              </button>
              <button
                type="button"
                className="pm-seg-btn"
                data-testid="premarket-unit-turnover"
                aria-pressed={unit === "turnover"}
                onClick={() => setUnit("turnover")}
              >
                억
              </button>
            </div>
          </div>
        )}
      </div>

      {stockSymbol === null ? (
        <div className="pm-empty">주식을 선택하면 장전 예상체결 추이를 볼 수 있습니다</div>
      ) : error !== null ? (
        <div className="pm-empty" role="alert">{error}</div>
      ) : loading && series.length === 0 ? (
        <div className="pm-empty">장전 예상체결 자료를 불러오는 중입니다</div>
      ) : rangeDates.length === 0 ? (
        <div className="pm-empty">수집된 장전 예상체결 자료가 없습니다</div>
      ) : (
        <div className="pm-workspace">
          <DateListPane
            rangeDates={rangeDates}
            series={series}
            focusDate={focusDate}
            pinnedDates={pinnedDates}
            spotDate={spotDate}
            range={range}
            unit={unit}
            onSpotDate={setSpotDate}
            onTogglePin={handleTogglePin}
            onSelectFocus={handleSelectFocus}
          />
          <OverlayChart
            series={series}
            focusDate={focusDate}
            pinnedDates={pinnedDates}
            spotDate={spotDate}
            unit={unit}
            bgStyle={bgStyle}
          />
        </div>
      )}
    </div>
  );
}
