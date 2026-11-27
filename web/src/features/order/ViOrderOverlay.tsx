import { useEffect, useRef, useState } from "react";
import type { ViDirection } from "../../api/generated/ViDirection";
import type { ViPlaybook } from "../../api/generated/ViPlaybook";
import type { ViPlaybookHorizon } from "../../api/generated/ViPlaybookHorizon";
import type { ViPlaybookMatch } from "../../api/generated/ViPlaybookMatch";
import { direction as toneOf, formatPercent, formatPrice } from "../../lib/format";
import type { ViViewState } from "../../stores/viSession";
import { Popover } from "../overlay/Popover";

const CARD_MINUTES: readonly number[] = [1, 3, 5];

function directionBadgeLabel(direction: ViDirection | null): string {
  if (direction === "up") return "상승 VI";
  if (direction === "down") return "하락 VI";
  return "VI 발동";
}

function kindLabel(kind: string): string {
  if (kind === "dynamic") return "동적";
  if (kind === "static") return "정적";
  if (kind === "both") return "동시";
  return kind;
}

function formatOptionalPercent(value: number | null): string {
  return value === null ? "-" : formatPercent(value);
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
  readonly state: ViViewState;
}

export function ViOrderOverlay({ state }: Props) {
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

  const { playbook, playbookStatus } = state;

  const horizonMap = new Map((playbook?.horizons ?? []).map((item) => [item.minutes, item]));

  return (
    <div ref={bottomRef} className="od-vi-bottom" data-testid="order-vi-bottom">
      {playbookStatus === "error" ? (
        <div className="od-vi-empty" data-tone="error" data-testid="order-vi-error" role="status">
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
