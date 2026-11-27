import { useEffect, useRef, useState } from "react";
import type { ViDirection } from "../../api/generated/ViDirection";
import { direction as toneOf, formatPercent, formatPrice, formatVolume } from "../../lib/format";
import type { CallAuctionViewState } from "../../stores/callAuctionSession";
import { formatCountdown, type ViExpectedPoint, type ViTrapAlert, type ViViewState } from "../../stores/viSession";
import { Popover } from "../overlay/Popover";

const INLINE_W = 72;
const INLINE_H = 18;
const POP_W = 240;
const POP_H = 44;

function directionBadgeLabel(direction: ViDirection | null): string {
  if (direction === "up") return "상승 VI";
  if (direction === "down") return "하락 VI";
  return "VI 발동";
}

function marketLabel(market: "krx" | "nxt"): string {
  return market === "nxt" ? "NXT" : "KRX";
}

function trapLabel(direction: ViDirection | null, alert: ViTrapAlert): string {
  if (alert.reason === "volume_shrink") return "잔량급감";
  if (direction === "down") return "막판급반등";
  return "막판급락";
}

function ExpectedSparkSvg({
  series,
  direction,
  width,
  height,
  className,
  testId,
}: {
  series: readonly ViExpectedPoint[];
  direction: ViDirection | "auction" | null;
  width: number;
  height: number;
  className: string;
  testId?: string;
}) {
  if (series.length === 0) {
    return (
      <div className="od-xbar-spark-empty" data-testid={testId}>
        대기
      </div>
    );
  }
  const padX = 2;
  const padY = 2;
  const barMaxH = Math.round(height * 0.44);
  const prices = series.map((point) => point.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceSpan = maxPrice - minPrice;
  const turnovers = series.map((point) => point.price * point.qty);
  const maxTurnover = Math.max(0, ...turnovers);
  const innerWidth = width - padX * 2;
  const innerHeight = height - padY * 2;
  const barWidth = Math.max(1.5, Math.min(6, innerWidth / Math.max(series.length, 1) - 1));

  const coords = series.map((point, index) => {
    const x = series.length === 1 ? padX + innerWidth / 2 : padX + (index / (series.length - 1)) * innerWidth;
    const norm = priceSpan > 0 ? (point.price - minPrice) / priceSpan : 0.5;
    const y = padY + (1 - norm) * innerHeight;
    const turnover = turnovers[index]!;
    const barH = maxTurnover > 0 ? Math.max(1, (turnover / maxTurnover) * barMaxH) : 0;
    return { x, y, barH };
  });

  const polyline = coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const latest = coords[coords.length - 1]!;

  return (
    <svg
      className={className}
      data-testid={testId}
      data-direction={direction ?? "unknown"}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="예상체결 추이"
    >
      {coords.map((point, index) => (
        <rect
          key={index}
          className="od-vi-spark-bar"
          x={(point.x - barWidth / 2).toFixed(1)}
          y={(height - point.barH).toFixed(1)}
          width={barWidth.toFixed(1)}
          height={point.barH.toFixed(1)}
        />
      ))}
      {coords.length >= 2 ? (
        <polyline className="od-vi-spark-line" fill="none" points={polyline} />
      ) : (
        <line
          className="od-vi-spark-line"
          x1={padX}
          y1={latest.y.toFixed(1)}
          x2={width - padX}
          y2={latest.y.toFixed(1)}
          strokeDasharray="3 3"
        />
      )}
      <circle className="od-vi-spark-dot" cx={latest.x.toFixed(1)} cy={latest.y.toFixed(1)} r="2" />
    </svg>
  );
}

interface Props {
  readonly viState: ViViewState;
  readonly auctionState: CallAuctionViewState;
  readonly previousClose: number | null;
  readonly variant: "order" | "book";
}

export function ExpectedHeaderBar({ viState, auctionState, previousClose, variant }: Props) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const barRef = useRef<HTMLButtonElement>(null);

  const activeKey =
    viState.kind === "active"
      ? `vi:${viState.sessionKey}`
      : auctionState.kind === "active"
        ? `auction:${auctionState.sessionKey}`
        : null;

  const popoverOpen = activeKey !== null && openKey === activeKey;

  useEffect(() => {
    if (openKey !== null && openKey !== activeKey) setOpenKey(null);
  }, [activeKey, openKey]);

  if (viState.kind === "active") {
    const { trigger, remainingSec, expectedSeries, trapAlert } = viState;
    const latest = expectedSeries[expectedSeries.length - 1] ?? null;
    const reference = previousClose ?? trigger.triggerPrice;
    const rate = latest !== null && reference !== null && reference > 0 ? ((latest.price - reference) / reference) * 100 : null;
    const dir = trigger.direction ?? "unknown";

    return (
      <>
        <button
          ref={barRef}
          type="button"
          className={variant === "order" ? "od-colhead od-xbar" : "mw-lhead od-xbar"}
          data-testid="order-vi-top"
          data-kind="vi"
          data-direction={dir}
          aria-expanded={popoverOpen}
          onClick={() => setOpenKey((prev) => (prev === activeKey ? null : activeKey))}
        >
          <span className="od-xbar-badge" data-testid="order-vi-badge" data-direction={dir}>
            {directionBadgeLabel(trigger.direction)} · {marketLabel(trigger.market)}
          </span>
          <span className="od-xbar-timer" data-testid="order-vi-countdown" data-late={remainingSec <= 15 ? "" : undefined}>
            {formatCountdown(remainingSec)}
          </span>
          {trapAlert !== null && (
            <span className="od-xbar-trap" data-testid="order-vi-trap" role="alert">
              {trapLabel(trigger.direction, trapAlert)}
            </span>
          )}
          {latest !== null && (
            <span className="od-xbar-latest" data-testid="order-vi-expected-latest">
              <b data-tone={rate === null ? "flat" : toneOf(rate)}>{formatPrice(latest.price, false)}</b>
              {rate !== null && <span data-tone={toneOf(rate)}>{formatPercent(rate)}</span>}
              <small>{formatVolume(latest.qty)}주</small>
            </span>
          )}
          <ExpectedSparkSvg
            series={expectedSeries}
            direction={trigger.direction}
            width={INLINE_W}
            height={INLINE_H}
            className="od-vi-spark od-xbar-spark"
            testId="order-vi-sparkline"
          />
        </button>
        {popoverOpen && (
          <Popover
            solid
            anchor={barRef}
            releasesClick={(target) => barRef.current?.contains(target) === true}
            onClose={() => setOpenKey(null)}
            role="dialog"
            aria-label="VI 예상체결 추이"
            className="od-xbar-popover"
            data-testid="order-expected-popover"
          >
            <div className="od-xbar-pop-head">
              <span className="od-xbar-badge" data-direction={dir}>
                {directionBadgeLabel(trigger.direction)} · {marketLabel(trigger.market)}
              </span>
              {trigger.triggerPrice !== null && <span className="od-xbar-pop-meta">발동 {formatPrice(trigger.triggerPrice, false)}</span>}
              <span className="od-xbar-timer" data-late={remainingSec <= 15 ? "" : undefined}>{formatCountdown(remainingSec)}</span>
            </div>
            <div className="od-xbar-pop-body">
              <ExpectedSparkSvg
                series={expectedSeries}
                direction={trigger.direction}
                width={POP_W}
                height={POP_H}
                className="od-vi-spark od-xbar-pop-spark"
              />
              {latest !== null && (
                <div className="od-vi-latest">
                  <b data-tone={rate === null ? "flat" : toneOf(rate)}>{formatPrice(latest.price, false)}</b>
                  {rate !== null && <span data-tone={toneOf(rate)}>{formatPercent(rate)}</span>}
                  <small>{formatVolume(latest.qty)}주</small>
                </div>
              )}
            </div>
          </Popover>
        )}
      </>
    );
  }

  if (auctionState.kind === "active") {
    const { auction, remainingSec, expectedSeries } = auctionState;
    const latest = expectedSeries[expectedSeries.length - 1] ?? null;
    const rate = latest !== null && previousClose !== null && previousClose > 0 ? ((latest.price - previousClose) / previousClose) * 100 : null;
    const sparkDir: ViDirection | "auction" = rate === null || rate === 0 ? "auction" : rate > 0 ? "up" : "down";

    return (
      <>
        <button
          ref={barRef}
          type="button"
          className={variant === "order" ? "od-colhead od-xbar" : "mw-lhead od-xbar"}
          data-testid="order-auction-top"
          data-kind="auction"
          data-auction-kind={auction.kind}
          aria-expanded={popoverOpen}
          onClick={() => setOpenKey((prev) => (prev === activeKey ? null : activeKey))}
        >
          <span className="od-xbar-badge" data-direction="auction">
            {auction.shortLabel}
          </span>
          <span className="od-xbar-timer" data-testid="order-auction-countdown" data-late={remainingSec <= 15 ? "" : undefined}>
            {formatCountdown(remainingSec)}
          </span>
          {latest !== null && (
            <span className="od-xbar-latest" data-testid="order-auction-expected-latest">
              <b data-tone={rate === null ? "flat" : toneOf(rate)}>{formatPrice(latest.price, false)}</b>
              {rate !== null && <span data-tone={toneOf(rate)}>{formatPercent(rate)}</span>}
              <small>{formatVolume(latest.qty)}주</small>
            </span>
          )}
          <ExpectedSparkSvg
            series={expectedSeries}
            direction={sparkDir}
            width={INLINE_W}
            height={INLINE_H}
            className="od-vi-spark od-xbar-spark"
            testId="order-auction-sparkline"
          />
        </button>
        {popoverOpen && (
          <Popover
            solid
            anchor={barRef}
            releasesClick={(target) => barRef.current?.contains(target) === true}
            onClose={() => setOpenKey(null)}
            role="dialog"
            aria-label="동시호가 예상체결 추이"
            className="od-xbar-popover"
            data-testid="order-expected-popover"
          >
            <div className="od-xbar-pop-head">
              <span className="od-xbar-badge" data-direction="auction">{auction.fullLabel}</span>
              <span className="od-xbar-timer" data-late={remainingSec <= 15 ? "" : undefined}>{formatCountdown(remainingSec)}</span>
            </div>
            <div className="od-xbar-pop-body">
              <ExpectedSparkSvg
                series={expectedSeries}
                direction={sparkDir}
                width={POP_W}
                height={POP_H}
                className="od-vi-spark od-xbar-pop-spark"
              />
              {latest !== null && (
                <div className="od-vi-latest">
                  <b data-tone={rate === null ? "flat" : toneOf(rate)}>{formatPrice(latest.price, false)}</b>
                  {rate !== null && <span data-tone={toneOf(rate)}>{formatPercent(rate)}</span>}
                  <small>{formatVolume(latest.qty)}주</small>
                </div>
              )}
            </div>
          </Popover>
        )}
      </>
    );
  }

  return null;
}
