import { useMemo, useState } from "react";
import type { Bar } from "../../api/generated/Bar";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { formatPrice } from "../../lib/format";
import type { BrokerCards, BrokerView } from "../../stores/layout";
import { BoardView } from "../brokers/BoardView";
import { DetailTable } from "../brokers/DetailTable";
import { ListView } from "../brokers/ListView";
import { boardAxis, brokerTracks, trackRuns, type TrackRun } from "../brokers/board";
import { gapContaining } from "../brokers/chartSync";
import type { BrokerDayResult } from "../brokers/useBrokerDay";
import "../brokers/brokers.css";
import { formatClock } from "../market-window/format";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import {
  formatReplayClock,
  formatSignedQty,
  formatWonCompact,
  type ReplayFrame,
  type ReplayTradeSummary,
} from "./replayModel";

interface Props {
  readonly frame: ReplayFrame | null;
  readonly previousClose: number | null;
  readonly dayStartUnix: UnixSeconds;
  readonly cursorSec: number;
  readonly tradeSummary: ReplayTradeSummary;
  readonly tapeMinWon: number;
  readonly onTapeMinWon: (minWon: number) => void;
  readonly onJumpSec: (sec: number) => void;
  readonly brokerDay: BrokerDayResult;
  readonly bars1m: readonly Bar[];
}

const TAPE_FILTERS = [
  { value: 0, label: "전체" },
  { value: 10_000_000, label: "1천만+" },
  { value: 50_000_000, label: "5천만+" },
  { value: 100_000_000, label: "1억+" },
] as const;

const EMPTY_RUNS: ReadonlyMap<string, readonly TrackRun[]> = new Map();

export function ReplayTapeAndBrokers({
  frame,
  previousClose,
  dayStartUnix,
  cursorSec,
  tradeSummary,
  tapeMinWon,
  onTapeMinWon,
  onJumpSec,
  brokerDay,
  bars1m,
}: Props) {
  const [brokerView, setBrokerView] = useState<BrokerView>("board");
  const [brokerCards, setBrokerCards] = useState<BrokerCards>("bars");
  const [selectedBroker, setSelectedBroker] = useState<string | null>(null);
  const [hoverBrokerCursor, setHoverBrokerCursor] = useState<UnixSeconds | null>(null);

  const replayUnix: UnixSeconds = dayStartUnix + Math.floor(cursorSec);
  const effectiveCursor = hoverBrokerCursor ?? replayUnix;

  const grid = brokerDay.state.grid;
  const tracks = useMemo(() => brokerTracks(grid), [grid]);
  const runsByCode = useMemo(() => (brokerView === "list" ? trackRuns(grid) : EMPTY_RUNS), [grid, brokerView]);
  const axis = useMemo(() => boardAxis(grid.times, dayStartUnix + 15 * 3600 + 30 * 60), [grid.times, dayStartUnix]);
  const selectedTrack = selectedBroker === null ? null : (tracks.find((track) => track.code === selectedBroker) ?? null);
  const activeGap = useMemo(() => gapContaining(brokerDay.gaps, effectiveCursor), [brokerDay.gaps, effectiveCursor]);
  const showEmpty = !brokerDay.failed && brokerDay.mode !== "loading" && grid.times.length === 0;
  const showContent = !brokerDay.failed && grid.times.length > 0;

  const strength = frame?.strength ?? 100;

  return (
    <section className="rp-col" aria-label="체결 테이프 및 거래원 입체분석">
      <div className="rp-tape-section">
        <div className="rp-pane-head">
          <div className="rp-pane-title">
            <span>체결 테이프</span>
            <span className="rp-muted rp-mono">{`${tradeSummary.rows.length}건`}</span>
          </div>
          <div className="rp-seg" role="group" aria-label="체결 금액 필터">
            {TAPE_FILTERS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-pressed={tapeMinWon === opt.value}
                onClick={() => onTapeMinWon(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="rp-strength-bar rp-mono">
          <div className="rp-kpi">
            <span>체결강도</span>
            <b className={strength >= 100 ? "rp-up" : "rp-down"}>{`${strength.toFixed(1)}%`}</b>
          </div>
          <div className="rp-kpi">
            <span>최근 1분 순매수</span>
            <b className={tradeSummary.net1mQty >= 0 ? "rp-up" : "rp-down"}>{`${formatSignedQty(tradeSummary.net1mQty)}주`}</b>
          </div>
          <div className="rp-kpi">
            <span>대량체결(5천만+)</span>
            <b>
              <span className="rp-up">{`매수 ${tradeSummary.whaleBuy}`}</span>
              {" · "}
              <span className="rp-down">{`매도 ${tradeSummary.whaleSell}`}</span>
            </b>
          </div>
        </div>

        <div className="rp-tape-head">
          <span>시각</span>
          <span>체결가</span>
          <span>수량</span>
          <span>대금</span>
        </div>

        <div className="rp-tape-list rp-mono" data-testid="replay-tape">
          {tradeSummary.rows.length === 0 ? (
            <div className="rp-tape-empty">
              {tapeMinWon > 0 ? `필터 조건(${formatWonCompact(tapeMinWon)}+)에 맞는 체결이 없습니다` : "이 시점까지 기록된 체결이 없습니다"}
            </div>
          ) : (
            tradeSummary.rows.map((tr) => {
              const pTone = previousClose !== null && previousClose > 0
                ? tr.price > previousClose
                  ? "rp-up"
                  : tr.price < previousClose
                    ? "rp-down"
                    : ""
                : "";
              return (
                <button
                  key={tr.key}
                  type="button"
                  className="rp-tape-row"
                  data-testid="replay-tape-row"
                  data-side={tr.side}
                  data-whale={tr.whale ? "true" : undefined}
                  onClick={() => onJumpSec(tr.secondOfDay)}
                >
                  <span className="rp-t-time">{formatReplayClock(tr.secondOfDay, false)}</span>
                  <span className={pTone}>{formatPrice(tr.price, false)}</span>
                  <span className="rp-t-qty">{formatPrice(tr.quantity, false)}</span>
                  <span className="rp-t-val">{formatWonCompact(tr.value)}</span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="rp-br-section br" data-testid="replay-brokers" aria-label="거래원 입체분석">
        <div className="br-bar">
          <div className="rp-seg" role="group" aria-label="거래원 보기">
            <button type="button" aria-pressed={brokerView === "board"} onClick={() => setBrokerView("board")}>입체</button>
            <button type="button" aria-pressed={brokerView === "list"} onClick={() => setBrokerView("list")}>거래원</button>
          </div>
          {brokerView === "board" && (
            <div className="rp-seg" role="group" aria-label="카드 모양">
              <button type="button" aria-pressed={brokerCards === "bars"} onClick={() => setBrokerCards("bars")}>막대</button>
              <button type="button" aria-pressed={brokerCards === "both"} onClick={() => setBrokerCards("both")}>막대+숫자</button>
              <button type="button" aria-pressed={brokerCards === "numbers"} onClick={() => setBrokerCards("numbers")}>숫자</button>
            </div>
          )}
          <span className="br-now rp-mono">
            <span className="br-time">{formatClock(effectiveCursor).slice(0, 5)}</span>
            <span className="br-price">{frame?.price !== null && frame?.price !== undefined ? formatPrice(frame.price, false) : "-"}</span>
          </span>
        </div>

        {activeGap !== null && (
          <div className="mw-replay-strip" role="status" data-kind="none">
            <span>{`거래원 수집 끊김 시각 · ${formatClock(effectiveCursor).slice(0, 5)}`}</span>
          </div>
        )}

        {brokerDay.failed && <ErrorState message="거래원을 받지 못했습니다" retry={brokerDay.retry} />}
        {!brokerDay.failed && brokerDay.mode === "loading" && <Skeleton label="거래원 불러오는 중" />}
        {showEmpty && <EmptyState title="이 날의 거래원 자료가 없습니다" />}

        {showContent && brokerView === "board" && (
          <>
            <BoardView
              tracks={tracks}
              axis={axis}
              gaps={brokerDay.gaps}
              mode={brokerCards}
              cursor={effectiveCursor}
              dimFuture
              selected={selectedBroker}
              onSelect={(code) => setSelectedBroker((prev) => (prev === code ? null : code))}
              onCursor={setHoverBrokerCursor}
            />
            {selectedTrack !== null && <DetailTable key={selectedTrack.code} track={selectedTrack} bars={bars1m} cursor={effectiveCursor} />}
            <div className="br-foot">
              <span><i className="br-swatch" data-kind="buy" />순매수</span>
              <span><i className="br-swatch" data-kind="sell" />순매도</span>
            </div>
          </>
        )}

        {showContent && brokerView === "list" && (
          <ListView
            tracks={tracks}
            runsByCode={runsByCode}
            axis={axis}
            cursor={effectiveCursor}
            onCursor={setHoverBrokerCursor}
          />
        )}
      </div>
    </section>
  );
}
