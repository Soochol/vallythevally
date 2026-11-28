import { useMemo, useRef, useState } from "react";
import { usePreMarketCompare, usePreMarketDays } from "../../api/premarket";
import { useSymbolInfo } from "../../api/queries";
import type { WindowId } from "../../layout/kinds";
import { isIndexCode } from "../../lib/symbol";
import { useFeedLink } from "../../stores/kiwoomLink";
import { FeedConnectGate, useLinkedSymbol } from "../market-window/MarketWindowGate";
import { Popover } from "../overlay/Popover";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { useWindowVisible } from "../workspace/windowVisibility";
import {
  formatSecOfDay,
  formatSignedPct,
  formatVolumeValue,
  formatWon,
  pointVolumeValue,
  selectRangeDates,
  valueTone,
  type CompareRange,
  type VolumeUnit,
} from "./logic";
import { OverlayChart } from "./OverlayChart";
import "./premarket.css";

export function PreMarketWindow({ id }: { id: WindowId }) {
  const link = useFeedLink();
  const connected = link === null || link.state === "connected";
  const linkedSymbol = useLinkedSymbol(id);
  const stockSymbol = linkedSymbol !== null && !isIndexCode(linkedSymbol) ? linkedSymbol : null;
  const symbolInfo = useSymbolInfo(stockSymbol);

  const [range, setRange] = useState<CompareRange>(10);
  const [unit, setUnit] = useState<VolumeUnit>("qty");
  const [helpOpen, setHelpOpen] = useState(false);
  const helpBtnRef = useRef<HTMLButtonElement>(null);

  const windowVisible = useWindowVisible();
  const daysQuery = usePreMarketDays(stockSymbol, windowVisible);
  const availableDays = daysQuery.data?.days ?? [];

  const rangeDates = useMemo(
    () => (stockSymbol === null ? [] : selectRangeDates(availableDays, range)),
    [stockSymbol, availableDays, range],
  );

  const compareQuery = usePreMarketCompare(stockSymbol, rangeDates, windowVisible);
  const series = compareQuery.data?.series ?? [];
  const focusSeries = series[series.length - 1] ?? null;
  const pastCount = Math.max(0, series.length - 1);
  const lastFocusPt = focusSeries?.points[focusSeries.points.length - 1] ?? null;

  const error = daysQuery.error?.message ?? compareQuery.error?.message ?? null;
  const loading = daysQuery.isLoading || compareQuery.isLoading;
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
          <span className="pm-sym-name">
            {stockSymbol !== null ? (symbolInfo.data?.name ?? stockSymbol) : "종목 미선택"}
          </span>

          {focusSeries && lastFocusPt ? (
            <div className="pm-head-metrics" data-testid="premarket-head-metrics">
              <span className="pm-hero-price">
                <span className="pm-hero-pct pm-val" data-tone={valueTone(lastFocusPt.expectedReturnPct)}>
                  {formatSignedPct(lastFocusPt.expectedReturnPct)}
                </span>
                <span className="pm-hero-won">{formatWon(lastFocusPt.expectedPriceWon)}원</span>
              </span>
              <span className="pm-hero-vol">
                <span className="pm-head-val pm-val" data-tone="accent">
                  {formatVolumeValue(pointVolumeValue(lastFocusPt, unit), unit)}
                </span>
              </span>
              {isFocusLive && (
                <span className="pm-badge" data-tone="live" data-testid="premarket-live-badge">
                  <span className="pm-live-dot" aria-hidden="true" />
                  <span>{formatSecOfDay(lastFocusPt.secOfDay, false)}</span>
                </span>
              )}
            </div>
          ) : isFocusPending ? (
            <div className="pm-head-metrics" data-testid="premarket-head-metrics">
              <span className="pm-badge" data-tone="ext" data-testid="premarket-pending-badge">
                <span className="pm-live-dot" aria-hidden="true" />
                <span>08:50 대기</span>
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

            <button
              ref={helpBtnRef}
              type="button"
              className="pm-help-btn"
              data-testid="premarket-help-btn"
              aria-label="범위 밴드 설명"
              aria-expanded={helpOpen}
              onClick={() => setHelpOpen((prev) => !prev)}
            >
              ?
            </button>

            {helpOpen && (
              <Popover
                solid
                anchor={helpBtnRef}
                releasesClick={(target) => helpBtnRef.current?.contains(target) === true}
                onClose={() => setHelpOpen(false)}
                role="dialog"
                aria-label="장전 동시호가 차트 범례"
                className="pm-help-popover"
                data-testid="premarket-help-popover"
              >
                <div className="pm-help-title">
                  {pastCount > 0 ? `과거 ${pastCount}일 범위 대비 오늘` : "오늘 예상체결 추이"}
                </div>
                <div className="pm-help-row">
                  <span className="pm-swatch-band" data-tier="outer" aria-hidden="true" />
                  <span>과거 전체 범위 (최저~최고)</span>
                </div>
                <div className="pm-help-row">
                  <span className="pm-swatch-band" data-tier="inner" aria-hidden="true" />
                  <span>과거 평소 구간 (25~75%)</span>
                </div>
                <div className="pm-help-row">
                  <span className="pm-swatch-line" data-kind="price" data-state="above" aria-hidden="true" />
                  <span>과거 최고 돌파 (예상가)</span>
                </div>
                <div className="pm-help-row">
                  <span className="pm-swatch-line" data-kind="vol" data-state="above" aria-hidden="true" />
                  <span>과거 최고 돌파 (예상물량)</span>
                </div>
                <div className="pm-help-row">
                  <span className="pm-swatch-line" data-kind="price" data-state="inside" aria-hidden="true" />
                  <span>과거 범위 내</span>
                </div>
                <div className="pm-help-row">
                  <span className="pm-swatch-line" data-kind="price" data-state="below" aria-hidden="true" />
                  <span>과거 최저 하회</span>
                </div>
              </Popover>
            )}
          </div>
        )}
      </div>

      {stockSymbol === null ? (
        <EmptyState title="주식을 선택하면 장전 예상체결 추이를 볼 수 있습니다" />
      ) : error !== null ? (
        <ErrorState
          message={error}
          retry={() => {
            void daysQuery.refetch();
            void compareQuery.refetch();
          }}
        />
      ) : loading && series.length === 0 ? (
        <Skeleton label="장전 예상체결 자료를 불러오는 중입니다" rows={6} />
      ) : rangeDates.length === 0 ? (
        !connected ? (
          <FeedConnectGate message={link?.message} />
        ) : (
          <EmptyState title="수집된 장전 예상체결 자료가 없습니다" />
        )
      ) : (
        <div className="pm-workspace">
          <OverlayChart series={series} unit={unit} />
        </div>
      )}
    </div>
  );
}
