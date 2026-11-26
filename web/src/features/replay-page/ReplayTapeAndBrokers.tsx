import { useEffect, useMemo, useRef, useState } from "react";
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
import type { ReplayEngine, ReplayEngineFrame } from "./replayEngine";
import {
  formatReplayClock,
  formatSignedQty,
  formatWonCompact,
} from "./replayModel";

interface Props {
  readonly engine: ReplayEngine;
  readonly previousClose: number | null;
  readonly dayStartUnix: UnixSeconds;
  readonly activeSecond: number;
  readonly tapeMinWon: number;
  readonly onTapeMinWon: (minWon: number) => void;
  readonly onJumpMs: (ms: number) => void;
  readonly brokerDay: BrokerDayResult;
  readonly bars1m: readonly Bar[];
}

const TAPE_FILTERS = [
  { value: 0, label: "전체" },
  { value: 10_000_000, label: "1천만+" },
  { value: 50_000_000, label: "5천만+" },
  { value: 100_000_000, label: "1억+" },
] as const;

const TAPE_SLOTS = Array.from({ length: 40 }, (_, i) => i);
const EMPTY_RUNS: ReadonlyMap<string, readonly TrackRun[]> = new Map();

interface TapeSlotRefs {
  btn: HTMLButtonElement | null;
  time: HTMLSpanElement | null;
  price: HTMLSpanElement | null;
  qty: HTMLSpanElement | null;
  val: HTMLSpanElement | null;
}

function setText(el: HTMLElement | null, value: string): void {
  if (el && el.textContent !== value) el.textContent = value;
}

export function ReplayTapeAndBrokers({
  engine,
  previousClose,
  dayStartUnix,
  activeSecond,
  tapeMinWon,
  onTapeMinWon,
  onJumpMs,
  brokerDay,
  bars1m,
}: Props) {
  const [brokerView, setBrokerView] = useState<BrokerView>("board");
  const [brokerCards, setBrokerCards] = useState<BrokerCards>("bars");
  const [selectedBroker, setSelectedBroker] = useState<string | null>(null);
  const [hoverBrokerCursor, setHoverBrokerCursor] = useState<UnixSeconds | null>(null);

  const countRef = useRef<HTMLSpanElement>(null);
  const strengthRef = useRef<HTMLElement>(null);
  const net1mRef = useRef<HTMLElement>(null);
  const whaleBuyRef = useRef<HTMLSpanElement>(null);
  const whaleSellRef = useRef<HTMLSpanElement>(null);
  const emptyRef = useRef<HTMLDivElement>(null);
  const brokerPriceRef = useRef<HTMLSpanElement>(null);
  const jumpTargetsRef = useRef<number[]>(TAPE_SLOTS.map(() => 0));
  const slotRefs = useRef<TapeSlotRefs[]>(
    TAPE_SLOTS.map(() => ({ btn: null, time: null, price: null, qty: null, val: null })),
  );

  useEffect(() => {
    const apply = (frame: ReplayEngineFrame) => {
      const perfNow = typeof performance !== "undefined" ? performance.now() : Date.now();
      const trades = frame.recentTrades;
      const withMs = frame.resolution === "tick";

      setText(countRef.current, `${trades.length}건`);
      if (strengthRef.current) {
        strengthRef.current.className = frame.strength >= 100 ? "rp-up" : "rp-down";
        setText(strengthRef.current, `${frame.strength.toFixed(1)}%`);
      }
      if (net1mRef.current) {
        net1mRef.current.className = frame.tradeSummary.net1mQty >= 0 ? "rp-up" : "rp-down";
        setText(net1mRef.current, `${formatSignedQty(frame.tradeSummary.net1mQty)}주`);
      }
      setText(whaleBuyRef.current, `매수 ${frame.tradeSummary.whaleBuy}`);
      setText(whaleSellRef.current, `매도 ${frame.tradeSummary.whaleSell}`);
      setText(brokerPriceRef.current, frame.price !== null ? formatPrice(frame.price, false) : "-");

      if (emptyRef.current) {
        emptyRef.current.hidden = trades.length > 0;
        if (trades.length === 0) {
          setText(
            emptyRef.current,
            tapeMinWon > 0
              ? `필터 조건(${formatWonCompact(tapeMinWon)}+)에 맞는 체결이 없습니다`
              : "이 시점까지 기록된 체결이 없습니다",
          );
        }
      }

      for (let i = 0; i < TAPE_SLOTS.length; i++) {
        const refs = slotRefs.current[i]!;
        const tr = trades[i];
        if (!refs.btn) continue;
        if (!tr) {
          refs.btn.hidden = true;
          refs.btn.removeAttribute("data-testid");
          continue;
        }
        refs.btn.hidden = false;
        refs.btn.setAttribute("data-testid", "replay-tape-row");
        refs.btn.setAttribute("data-side", tr.side);
        if (tr.whale) refs.btn.setAttribute("data-whale", "true");
        else refs.btn.removeAttribute("data-whale");
        if (perfNow < tr.freshUntilMs) refs.btn.setAttribute("data-fresh", "true");
        else refs.btn.removeAttribute("data-fresh");
        jumpTargetsRef.current[i] = tr.recvMs;

        setText(refs.time, formatReplayClock(tr.recvMs / 1000, withMs));
        if (refs.price) {
          const pTone = previousClose !== null && previousClose > 0
            ? tr.price > previousClose
              ? "rp-up"
              : tr.price < previousClose
                ? "rp-down"
                : ""
            : "";
          if (refs.price.className !== pTone) refs.price.className = pTone;
          setText(refs.price, formatPrice(tr.price, false));
        }
        setText(refs.qty, formatPrice(tr.quantity, false));
        setText(refs.val, formatWonCompact(tr.value));
      }
    };

    return engine.subscribeFrame(apply);
  }, [engine, previousClose, tapeMinWon]);

  const replayUnix: UnixSeconds = dayStartUnix + activeSecond;
  const effectiveCursor = hoverBrokerCursor ?? replayUnix;

  const grid = brokerDay.state.grid;
  const tracks = useMemo(() => brokerTracks(grid), [grid]);
  const runsByCode = useMemo(() => (brokerView === "list" ? trackRuns(grid) : EMPTY_RUNS), [grid, brokerView]);
  const axis = useMemo(() => boardAxis(grid.times, dayStartUnix + 15 * 3600 + 30 * 60), [grid.times, dayStartUnix]);
  const selectedTrack = selectedBroker === null ? null : (tracks.find((track) => track.code === selectedBroker) ?? null);
  const activeGap = useMemo(() => gapContaining(brokerDay.gaps, effectiveCursor), [brokerDay.gaps, effectiveCursor]);
  const showEmpty = !brokerDay.failed && brokerDay.mode !== "loading" && grid.times.length === 0;
  const showContent = !brokerDay.failed && grid.times.length > 0;

  return (
    <section className="rp-col" aria-label="체결 테이프 및 거래원 입체분석">
      <div className="rp-tape-section">
        <div className="rp-pane-head">
          <div className="rp-pane-title">
            <span>체결 테이프</span>
            <span ref={countRef} className="rp-muted rp-mono">0건</span>
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
            <b ref={strengthRef} className="rp-up">100.0%</b>
          </div>
          <div className="rp-kpi">
            <span>최근 1분 순매수</span>
            <b ref={net1mRef} className="rp-up">0주</b>
          </div>
          <div className="rp-kpi">
            <span>대량체결(5천만+)</span>
            <b>
              <span ref={whaleBuyRef} className="rp-up">매수 0</span>
              {" · "}
              <span ref={whaleSellRef} className="rp-down">매도 0</span>
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
          <div ref={emptyRef} className="rp-tape-empty">이 시점까지 기록된 체결이 없습니다</div>
          {TAPE_SLOTS.map((idx) => (
            <button
              key={idx}
              ref={(el) => {
                slotRefs.current[idx]!.btn = el;
              }}
              type="button"
              className="rp-tape-row"
              hidden
              onClick={() => onJumpMs(jumpTargetsRef.current[idx] ?? 0)}
            >
              <span
                ref={(el) => {
                  slotRefs.current[idx]!.time = el;
                }}
                className="rp-t-time"
              />
              <span
                ref={(el) => {
                  slotRefs.current[idx]!.price = el;
                }}
              />
              <span
                ref={(el) => {
                  slotRefs.current[idx]!.qty = el;
                }}
                className="rp-t-qty"
              />
              <span
                ref={(el) => {
                  slotRefs.current[idx]!.val = el;
                }}
                className="rp-t-val"
              />
            </button>
          ))}
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
            <span ref={brokerPriceRef} className="br-price">-</span>
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
