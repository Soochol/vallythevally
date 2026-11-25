import { useEffect, useRef, useState } from "react";
import type { ViDirection } from "../../api/generated/ViDirection";
import type { ViPlaybook } from "../../api/generated/ViPlaybook";
import type { ViPlaybookHorizon } from "../../api/generated/ViPlaybookHorizon";
import type { ViPlaybookMatch } from "../../api/generated/ViPlaybookMatch";
import { direction as toneOf, formatPercent, formatPrice, formatVolume } from "../../lib/format";
import { formatCountdown, type ViExpectedPoint, type ViTrapAlert, type ViViewState } from "../../stores/viSession";
import { Popover } from "../overlay/Popover";

const SPARK_WIDTH = 240;
const SPARK_HEIGHT = 36;
const SPARK_PAD_X = 3;
const SPARK_PAD_TOP = 4;
const SPARK_PAD_BOTTOM = 4;
const SPARK_BAR_MAX_H = 14;
const CARD_MINUTES: readonly number[] = [1, 3, 5];

function directionBadgeLabel(direction: ViDirection | null): string {
  if (direction === "up") return "상승 VI";
  if (direction === "down") return "하락 VI";
  return "VI 발동";
}

function marketLabel(market: "krx" | "nxt"): string {
  return market === "nxt" ? "NXT" : "KRX";
}

function kindLabel(kind: string): string {
  if (kind === "dynamic") return "동적";
  if (kind === "static") return "정적";
  if (kind === "both") return "동시";
  return kind;
}

function trapLabel(direction: ViDirection | null, alert: ViTrapAlert): string {
  if (alert.reason === "volume_shrink") return "막판 15초 급락 · 잔량급감";
  if (direction === "down") return "막판 15초 급반등";
  return "막판 15초 급락";
}

function formatOptionalPercent(value: number | null): string {
  return value === null ? "-" : formatPercent(value);
}

function ViExpectedSparkline({ series, direction }: { series: readonly ViExpectedPoint[]; direction: ViDirection | null }) {
  if (series.length === 0) {
    return (
      <div className="od-vi-spark-empty" data-testid="order-vi-sparkline">
        0H 예상체결 대기
      </div>
    );
  }
  const prices = series.map((point) => point.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceSpan = maxPrice - minPrice;
  const turnovers = series.map((point) => point.price * point.qty);
  const maxTurnover = Math.max(0, ...turnovers);
  const innerWidth = SPARK_WIDTH - SPARK_PAD_X * 2;
  const innerHeight = SPARK_HEIGHT - SPARK_PAD_TOP - SPARK_PAD_BOTTOM;
  const barWidth = Math.max(2, Math.min(8, innerWidth / Math.max(series.length, 1) - 1));

  const coords = series.map((point, index) => {
    const x = series.length === 1 ? SPARK_PAD_X + innerWidth / 2 : SPARK_PAD_X + (index / (series.length - 1)) * innerWidth;
    const norm = priceSpan > 0 ? (point.price - minPrice) / priceSpan : 0.5;
    const y = SPARK_PAD_TOP + (1 - norm) * innerHeight;
    const turnover = turnovers[index]!;
    const barH = maxTurnover > 0 ? Math.max(1, (turnover / maxTurnover) * SPARK_BAR_MAX_H) : 0;
    return { x, y, barH };
  });

  const polyline = coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const latest = coords[coords.length - 1]!;

  return (
    <svg
      className="od-vi-spark"
      data-testid="order-vi-sparkline"
      data-direction={direction ?? "unknown"}
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="예상체결 추이"
    >
      {coords.map((point, index) => (
        <rect
          key={index}
          className="od-vi-spark-bar"
          x={(point.x - barWidth / 2).toFixed(1)}
          y={(SPARK_HEIGHT - point.barH).toFixed(1)}
          width={barWidth.toFixed(1)}
          height={point.barH.toFixed(1)}
        />
      ))}
      {coords.length >= 2 ? (
        <polyline className="od-vi-spark-line" fill="none" points={polyline} />
      ) : (
        <line
          className="od-vi-spark-line"
          x1={SPARK_PAD_X}
          y1={latest.y.toFixed(1)}
          x2={SPARK_WIDTH - SPARK_PAD_X}
          y2={latest.y.toFixed(1)}
          strokeDasharray="3 3"
        />
      )}
      <circle className="od-vi-spark-dot" cx={latest.x.toFixed(1)} cy={latest.y.toFixed(1)} r="2.5" />
    </svg>
  );
}

function PlaybookPopover({
  anchor,
  playbook,
  onClose,
}: {
  anchor: React.RefObject<HTMLDivElement | null>;
  playbook: ViPlaybook;
  onClose: () => void;
}) {
  return (
    <Popover
      solid
      anchor={anchor}
      releasesClick={(target) => anchor.current?.contains(target) === true}
      onClose={onClose}
      role="dialog"
      aria-label="과거 VI 이력 상세"
      className="od-vi-popover"
      data-testid="order-vi-popover"
    >
      <div className="od-vi-pop-head">
        <h4>
          {directionBadgeLabel(playbook.direction)} 과거 이력 ({playbook.sampleCount}건 · 최근 {playbook.lookbackDays}거래일)
        </h4>
        <button type="button" className="od-vi-pop-close" onClick={onClose}>
          닫기
        </button>
      </div>
      <div className="od-vi-pop-horizons" data-testid="order-vi-pop-horizons">
        <div className="od-vi-pop-hhead">
          <span>구간</span>
          <span>표본</span>
          <span>승률</span>
          <span>평균수익</span>
          <span>평균MAE</span>
        </div>
        {playbook.horizons.map((horizon: ViPlaybookHorizon) => {
          const hasSamples = horizon.samples > 0;
          return (
            <div key={horizon.minutes} className="od-vi-pop-hrow">
              <span>+{horizon.minutes}분</span>
              <span>{horizon.samples}건</span>
              <b>{hasSamples ? `${Math.round(horizon.winRatePct)}%` : "-"}</b>
              <b data-tone={hasSamples ? toneOf(horizon.avgReturnPct) : "flat"}>
                {hasSamples ? formatPercent(horizon.avgReturnPct) : "-"}
              </b>
              <span data-tone={hasSamples && horizon.avgMaePct < 0 ? "down" : "flat"}>
                {hasSamples ? formatPercent(horizon.avgMaePct) : "-"}
              </span>
            </div>
          );
        })}
      </div>
      {playbook.recentMatches.length > 0 && (
        <div className="od-vi-pop-matches" data-testid="order-vi-pop-matches">
          <div className="od-vi-pop-mhead">
            <span>일자 · 시각</span>
            <span>구분</span>
            <span>해제가</span>
            <span>+1분</span>
            <span>+3분</span>
            <span>+5분</span>
            <span>+10분</span>
            <span>MAE</span>
          </div>
          <ul className="od-vi-pop-mlist">
            {playbook.recentMatches.map((match: ViPlaybookMatch, index: number) => (
              <li key={`${match.date}-${match.triggeredAt}-${index}`} className="od-vi-pop-mrow">
                <span className="od-vi-pop-date">
                  {match.date} {match.triggeredAt.slice(0, 5)}
                  {match.lateDropDetected && <em className="od-vi-pop-trap">막판급락</em>}
                </span>
                <span>{kindLabel(match.kind)}</span>
                <span>{match.releasePrice === null ? "-" : formatPrice(match.releasePrice, false)}</span>
                <span data-tone={match.return1mPct === null ? "flat" : toneOf(match.return1mPct)}>{formatOptionalPercent(match.return1mPct)}</span>
                <span data-tone={match.return3mPct === null ? "flat" : toneOf(match.return3mPct)}>{formatOptionalPercent(match.return3mPct)}</span>
                <span data-tone={match.return5mPct === null ? "flat" : toneOf(match.return5mPct)}>{formatOptionalPercent(match.return5mPct)}</span>
                <span data-tone={match.return10mPct === null ? "flat" : toneOf(match.return10mPct)}>{formatOptionalPercent(match.return10mPct)}</span>
                <span data-tone={match.mae5mPct !== null && match.mae5mPct < 0 ? "down" : "flat"}>{formatOptionalPercent(match.mae5mPct)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Popover>
  );
}

interface Props {
  readonly band: "top" | "bottom";
  readonly state: ViViewState;
  readonly previousClose: number | null;
}

export function ViOrderOverlay({ band, state, previousClose }: Props) {
  const activeSessionKey = state.kind === "active" ? state.sessionKey : null;
  const [openedSessionKey, setOpenedSessionKey] = useState<string | null>(null);
  const popoverOpen = activeSessionKey !== null && openedSessionKey === activeSessionKey;
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openedSessionKey !== null && openedSessionKey !== activeSessionKey) {
      setOpenedSessionKey(null);
    }
  }, [activeSessionKey, openedSessionKey]);

  if (state.kind === "inactive") return null;

  const { trigger, remainingSec, expectedSeries, trapAlert, playbook, playbookStatus } = state;

  if (band === "top") {
    const latest = expectedSeries[expectedSeries.length - 1] ?? null;
    const reference = previousClose ?? trigger.triggerPrice;
    const rate = latest !== null && reference !== null && reference > 0 ? ((latest.price - reference) / reference) * 100 : null;
    return (
      <div className="od-vi-top" data-testid="order-vi-top" data-direction={trigger.direction ?? "unknown"}>
        <div className="od-vi-top-row">
          <span className="od-vi-badge" data-testid="order-vi-badge" data-direction={trigger.direction ?? "unknown"}>
            {directionBadgeLabel(trigger.direction)} · {marketLabel(trigger.market)}
          </span>
          {trigger.triggerPrice !== null && (
            <span className="od-vi-meta">발동 {formatPrice(trigger.triggerPrice, false)}</span>
          )}
          {trapAlert !== null && (
            <span className="od-vi-trap" data-testid="order-vi-trap" role="alert">
              {trapLabel(trigger.direction, trapAlert)}
            </span>
          )}
          <span className="od-vi-timer" data-testid="order-vi-countdown" data-late={remainingSec <= 15 ? "" : undefined}>
            {formatCountdown(remainingSec)}
          </span>
        </div>
        <div className="od-vi-spark-row">
          <ViExpectedSparkline series={expectedSeries} direction={trigger.direction} />
          {latest !== null && (
            <div className="od-vi-latest" data-testid="order-vi-expected-latest">
              <b data-tone={rate === null ? "flat" : toneOf(rate)}>{formatPrice(latest.price, false)}</b>
              {rate !== null && <span data-tone={toneOf(rate)}>{formatPercent(rate)}</span>}
              <small>{formatVolume(latest.qty)}주</small>
            </div>
          )}
        </div>
      </div>
    );
  }

  const horizonMap = new Map((playbook?.horizons ?? []).map((item) => [item.minutes, item]));

  return (
    <div ref={bottomRef} className="od-vi-bottom" data-testid="order-vi-bottom">
      {playbookStatus === "error" ? (
        <div className="od-vi-empty" data-testid="order-vi-error" role="status">
          과거 VI 이력을 불러오지 못했습니다
        </div>
      ) : playbook === null ? (
        <div className="od-vi-empty" data-testid="order-vi-loading">
          과거 VI 이력 조회 중…
        </div>
      ) : playbook.sampleCount === 0 ? (
        <div className="od-vi-empty" data-testid="order-vi-empty">
          이력 부족{playbook.lookbackDays > 0 ? ` · 최근 ${playbook.lookbackDays}거래일 일치 VI 없음` : ""}
        </div>
      ) : (
        <>
          <div className="od-vi-bottom-head">
            <span>과거 VI 플레이북</span>
            <small>{playbook.sampleCount}건 · 최근 {playbook.lookbackDays}일</small>
          </div>
          <div className="od-vi-cards">
            {CARD_MINUTES.map((minutes) => {
              const horizon = horizonMap.get(minutes);
              const hasSamples = horizon !== undefined && horizon.samples > 0;
              const winRate = hasSamples ? `${Math.round(horizon.winRatePct)}%` : "-";
              const avgReturn = hasSamples ? formatPercent(horizon.avgReturnPct) : "-";
              const tone = hasSamples ? toneOf(horizon.avgReturnPct) : "flat";
              return (
                <button
                  key={minutes}
                  type="button"
                  className="od-vi-card"
                  data-testid={`order-vi-card-${minutes}`}
                  aria-expanded={popoverOpen}
                  onClick={() => setOpenedSessionKey((prev) => (prev === activeSessionKey ? null : activeSessionKey))}
                >
                  <span className="od-vi-card-min">+{minutes}분</span>
                  <b className="od-vi-card-win">승률 {winRate}</b>
                  <span className="od-vi-card-ret" data-tone={tone}>
                    {avgReturn}
                  </span>
                </button>
              );
            })}
          </div>
          {popoverOpen && <PlaybookPopover anchor={bottomRef} playbook={playbook} onClose={() => setOpenedSessionKey(null)} />}
        </>
      )}
    </div>
  );
}
