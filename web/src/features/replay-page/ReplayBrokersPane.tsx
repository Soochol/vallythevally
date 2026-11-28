import { useEffect, useMemo, useRef, useState } from "react";
import type { Bar } from "../../api/generated/Bar";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { formatPrice } from "../../lib/format";
import type { BrokerCards, BrokerView } from "../../stores/layout";
import { useUiStore } from "../../stores/ui";
import { BoardView } from "../brokers/BoardView";
import { DetailTable } from "../brokers/DetailTable";
import { ListView } from "../brokers/ListView";
import { TableView } from "../brokers/TableView";
import { TransferView } from "../brokers/TransferView";
import { boardAxis, brokerTracks, trackRuns, type TrackRun } from "../brokers/board";
import { gapContaining } from "../brokers/history";
import type { BrokerDayResult } from "../brokers/useBrokerDay";
import "../brokers/brokers.css";
import { formatClock } from "../market-window/format";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import type { ReplayEngine, ReplayEngineFrame } from "./replayEngine";
import { formatReplayClock, formatSignedQty } from "./replayModel";
import type { ReplayPaperEngine } from "./replayPaperEngine";

type BottomPaneMode = "brokers" | "journal";
type JournalTab = "fills" | "open" | "stats";

interface Props {
  readonly engine: ReplayEngine;
  readonly paper: ReplayPaperEngine;
  readonly dayStartUnix: UnixSeconds;
  readonly activeSecond: number;
  readonly blindMode: boolean;
  readonly onJumpMs: (ms: number) => void;
  readonly brokerDay: BrokerDayResult;
  readonly bars1m: readonly Bar[];
}

const EMPTY_RUNS: ReadonlyMap<string, readonly TrackRun[]> = new Map();

function setText(el: HTMLElement | null, value: string): void {
  if (el && el.textContent !== value) el.textContent = value;
}

export function ReplayBrokersPane({
  engine,
  paper,
  dayStartUnix,
  activeSecond,
  blindMode,
  onJumpMs,
  brokerDay,
  bars1m,
}: Props) {
  const [bottomPane, setBottomPane] = useState<BottomPaneMode>("brokers");
  const [journalTab, setJournalTab] = useState<JournalTab>("fills");
  const [paperTick, setPaperTick] = useState(0);
  const brokerView = useUiStore((s) => s.prefs.brokers.replayView);
  const brokerCards = useUiStore((s) => s.prefs.brokers.replayCards);
  const setBrokerPrefs = useUiStore((s) => s.setBrokerPrefs);
  const setBrokerView = (replayView: BrokerView) => setBrokerPrefs({ replayView });
  const setBrokerCards = (replayCards: BrokerCards) => setBrokerPrefs({ replayCards });
  const [selectedBroker, setSelectedBroker] = useState<string | null>(null);
  const [hoverBrokerCursor, setHoverBrokerCursor] = useState<UnixSeconds | null>(null);

  const brokerPriceRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    return paper.subscribe(() => setPaperTick((t) => t + 1));
  }, [paper]);

  useEffect(() => {
    const apply = (frame: ReplayEngineFrame) => {
      setText(brokerPriceRef.current, frame.price !== null ? formatPrice(frame.price, false) : "-");
    };
    return engine.subscribeFrame(apply);
  }, [engine]);

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

  const transferData = useMemo(() => {
    let count = 0;
    for (let i = 0; i < grid.snapshots.length; i++) {
      if (grid.snapshots[i]!.t <= effectiveCursor) count = i + 1;
      else break;
    }
    if (count >= 2 || blindMode) {
      return {
        snapshots: grid.snapshots.slice(0, count),
        gapBefore: grid.gapBefore.slice(0, count),
      };
    }
    return {
      snapshots: grid.snapshots,
      gapBefore: grid.gapBefore,
    };
  }, [grid.snapshots, grid.gapBefore, effectiveCursor, blindMode]);

  const paperSummary = useMemo(() => paper.getSummary(engine.getFrame().price), [paper, engine, paperTick]);
  const closedFills = useMemo(
    () => paperSummary.fills.filter((f) => f.realizedPnl !== null),
    [paperSummary.fills],
  );
  const winCount = useMemo(
    () => closedFills.filter((f) => (f.realizedPnl ?? 0) > 0).length,
    [closedFills],
  );
  const winRate = closedFills.length > 0 ? (winCount / closedFills.length) * 100 : 0;
  const avgRealized = closedFills.length > 0
    ? closedFills.reduce((sum, f) => sum + (f.realizedPnl ?? 0), 0) / closedFills.length
    : 0;

  return (
    <section className="rp-col" aria-label="거래원 및 가상매매" data-testid="replay-brokers-pane">
      <div className="rp-bottom-switch">
        <div className="rp-seg" role="group" aria-label="하단 분석 전환">
          <button
            type="button"
            data-testid="replay-tab-brokers"
            aria-pressed={bottomPane === "brokers"}
            onClick={() => setBottomPane("brokers")}
          >
            거래원
          </button>
          <button
            type="button"
            data-testid="replay-tab-journal"
            aria-pressed={bottomPane === "journal"}
            onClick={() => setBottomPane("journal")}
          >
            {`가상 매매 (${paperSummary.fills.length}/${paperSummary.openOrders.length})`}
          </button>
        </div>

        {bottomPane === "brokers" ? (
          <div className="rp-brokers-head-controls">
            <div className="rp-seg" role="group" aria-label="거래원 보기">
              <button
                type="button"
                data-testid="replay-broker-view-board"
                aria-pressed={brokerView === "board"}
                onClick={() => setBrokerView("board")}
              >
                입체
              </button>
              <button
                type="button"
                data-testid="replay-broker-view-list"
                aria-pressed={brokerView === "list"}
                onClick={() => setBrokerView("list")}
              >
                거래원
              </button>
              <button
                type="button"
                data-testid="replay-broker-view-table"
                aria-pressed={brokerView === "table"}
                onClick={() => setBrokerView("table")}
              >
                기본
              </button>
              <button
                type="button"
                data-testid="replay-broker-view-transfer"
                aria-pressed={brokerView === "transfer"}
                onClick={() => setBrokerView("transfer")}
              >
                이동
              </button>
            </div>
            {brokerView === "board" && (
              <div className="rp-seg" role="group" aria-label="카드 모양">
                <button type="button" aria-pressed={brokerCards === "bars"} onClick={() => setBrokerCards("bars")}>막대</button>
                <button type="button" aria-pressed={brokerCards === "both"} onClick={() => setBrokerCards("both")}>복합</button>
                <button type="button" aria-pressed={brokerCards === "numbers"} onClick={() => setBrokerCards("numbers")}>숫자</button>
              </div>
            )}
            <span className="br-now rp-mono">
              <span className="br-time">{formatClock(effectiveCursor).slice(0, 5)}</span>
              <span ref={brokerPriceRef} className="br-price">-</span>
            </span>
          </div>
        ) : (
          <div className="rp-seg" role="group" aria-label="가상 매매 보기">
            <button type="button" aria-pressed={journalTab === "fills"} onClick={() => setJournalTab("fills")}>
              {`체결 ${paperSummary.fills.length}`}
            </button>
            <button type="button" aria-pressed={journalTab === "open"} onClick={() => setJournalTab("open")}>
              {`미체결 ${paperSummary.openOrders.length}`}
            </button>
            <button type="button" aria-pressed={journalTab === "stats"} onClick={() => setJournalTab("stats")}>
              통계
            </button>
          </div>
        )}
      </div>

      {bottomPane === "brokers" ? (
        <div className="rp-br-section br" data-testid="replay-brokers" aria-label="거래원 입체분석">
          {activeGap !== null && (
            <div className="mw-replay-strip" role="status" data-kind="none">
              <span>{`거래원 수집 끊김 시각 · ${formatClock(effectiveCursor).slice(0, 5)}`}</span>
            </div>
          )}

          {brokerDay.failed && <ErrorState message="거래원을 받지 못했습니다" retry={brokerDay.retry} />}
          {!brokerDay.failed && brokerDay.mode === "loading" && <Skeleton label="거래원 불러오는 중" />}
          {showEmpty && <EmptyState title="이 날의 거래원 자료가 없습니다" />}

          {showContent && brokerView === "transfer" && (
            <TransferView
              snapshots={transferData.snapshots}
              gapBefore={transferData.gapBefore}
              gaps={brokerDay.gaps}
              bars={bars1m}
              axis={axis}
            />
          )}

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

          {showContent && brokerView === "table" && (
            <TableView snapshots={grid.snapshots} cursor={effectiveCursor} testIdPrefix="replay-broker" />
          )}
        </div>
      ) : (
        <div className="rp-journal-section" data-testid="replay-sim-journal" aria-label="가상 매매 기록">
          {journalTab === "fills" && (
            <>
              <div className="rp-jfill-head">
                <span>시각</span>
                <span>구분</span>
                <span>체결가</span>
                <span>수량</span>
                <span>실현손익</span>
              </div>
              <div className="rp-journal-list rp-mono">
                {paperSummary.fills.length === 0 ? (
                  <div className="rp-tape-empty">아직 가상 체결 내역이 없습니다</div>
                ) : (
                  paperSummary.fills.map((fill) => (
                    <button
                      key={fill.id}
                      type="button"
                      className="rp-jfill-row"
                      data-testid="replay-sim-fill-row"
                      onClick={() => onJumpMs(fill.ms)}
                    >
                      <span className="rp-muted">{formatReplayClock(fill.ms / 1000, false)}</span>
                      <span className={fill.side === "buy" ? "rp-up rp-j-side" : "rp-down rp-j-side"}>
                        {fill.side === "buy" ? "매수" : "매도"}
                      </span>
                      <span>{formatPrice(fill.price, false)}</span>
                      <span>{formatPrice(fill.quantity, false)}</span>
                      {fill.realizedPnl === null ? (
                        <span className="rp-muted">진입</span>
                      ) : (
                        <span className={fill.realizedPnl > 0 ? "rp-up" : fill.realizedPnl < 0 ? "rp-down" : ""}>
                          {formatSignedQty(fill.realizedPnl)}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            </>
          )}

          {journalTab === "open" && (
            <>
              <div className="rp-jopen-head">
                <span>시각</span>
                <span>구분</span>
                <span>주문가</span>
                <span>수량</span>
                <span />
              </div>
              <div className="rp-journal-list rp-mono">
                {paperSummary.openOrders.length === 0 ? (
                  <div className="rp-tape-empty">대기 중인 가상 미체결 주문이 없습니다</div>
                ) : (
                  paperSummary.openOrders.map((order) => (
                    <div key={order.id} className="rp-jopen-row" data-testid="replay-sim-open-row">
                      <span className="rp-muted">{formatReplayClock(order.createdMs / 1000, false)}</span>
                      <span className={order.side === "buy" ? "rp-up rp-j-side" : "rp-down rp-j-side"}>
                        {order.side === "buy" ? "매수" : "매도"}
                      </span>
                      <span>{formatPrice(order.price, false)}</span>
                      <span>{formatPrice(order.quantity, false)}</span>
                      <button
                        type="button"
                        className="rp-sim-mini-btn"
                        data-danger=""
                        onClick={() => paper.cancelOrderById(order.id, engine.getFrame().cursorMs)}
                      >
                        취소
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {journalTab === "stats" && (
            <div className="rp-jstats-grid rp-mono">
              <div className="rp-jstat-card">
                <span>총 체결 건수</span>
                <b>{`${paperSummary.fills.length}건 (청산 ${closedFills.length})`}</b>
              </div>
              <div className="rp-jstat-card">
                <span>청산 승률</span>
                <b className={closedFills.length === 0 ? "rp-muted" : winRate >= 50 ? "rp-up" : "rp-down"}>{`${winRate.toFixed(1)}%`}</b>
              </div>
              <div className="rp-jstat-card">
                <span>건당 평균 손익</span>
                <b className={avgRealized > 0 ? "rp-up" : avgRealized < 0 ? "rp-down" : "rp-muted"}>{`${formatSignedQty(avgRealized)}원`}</b>
              </div>
              <div className="rp-jstat-card">
                <span>누적 수수료·세금</span>
                <b className="rp-muted">{`${formatPrice(paperSummary.totalFees, false)}원`}</b>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
