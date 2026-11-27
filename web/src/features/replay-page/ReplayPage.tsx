import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { formatPercent, formatPrice } from "../../lib/format";
import { isIndexCode } from "../../lib/symbol";
import { isTypingTarget } from "../../lib/typingTarget";
import { chartWindows, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { PageFrame } from "../pages/PageFrame";
import { useCanvasPalette } from "./canvasTheme";
import { ReplayBrokersPane } from "./ReplayBrokersPane";
import { ReplayCharts } from "./ReplayCharts";
import { ReplayDatePicker } from "./ReplayDatePicker";
import { type LoopRange, ReplayDeck, type TimelineZoom } from "./ReplayDeck";
import { ReplayLadder } from "./ReplayLadder";
import { ReplayProgramPane } from "./ReplayProgramPane";
import { ReplaySplitter } from "./ReplaySplitter";
import { ReplayTradesPane } from "./ReplayTradesPane";
import {
  type PlaybackMode,
  ReplayEngine,
  type ReplayEngineControlState,
  type ReplayEngineFrame,
  TICK_REPLAY_RATES,
  TIME_REPLAY_SPEEDS,
} from "./replayEngine";
import {
  type DeltaMode,
  formatReplayClock,
  formatShortDay,
  formatSignedQty,
  formatWonCompact,
} from "./replayModel";
import { ReplayPaperEngine } from "./replayPaperEngine";
import { useReplayData } from "./useReplayData";
import "./replayPage.css";

const DEFAULT_SYMBOL: SymbolCode = "005930";
const DEFAULT_MODE: PlaybackMode = { kind: "time", speed: 1, skipIdleMs: null };
const DEFAULT_LEFT_SHARE = 0.742;
const DEFAULT_CHART_SHARE = 0.668;
const DEFAULT_TRADES_SHARE = 0.46;
const DEFAULT_LADDER_SHARE = 0.537;

function initialSymbol(param: string | null): SymbolCode {
  if (param && !isIndexCode(param)) return param;
  const activeId = useSelectionStore.getState().activeCell;
  const activeChart = chartWindows(useLayoutStore.getState().layout).find((cell) => cell.id === activeId);
  if (activeChart && !isIndexCode(activeChart.symbol)) return activeChart.symbol;
  const recent = useUiStore.getState().prefs.recentSymbols.find((code) => !isIndexCode(code));
  return recent ?? DEFAULT_SYMBOL;
}

function setText(el: HTMLElement | null, value: string): void {
  if (el && el.textContent !== value) el.textContent = value;
}

export function ReplayPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramSymbol = searchParams.get("symbol");
  const paramDate = searchParams.get("date");

  const [code, setCode] = useState<SymbolCode>(() => initialSymbol(paramSymbol));
  const [requestedDate, setRequestedDate] = useState<string | null>(() =>
    paramDate && /^\d{8}$/.test(paramDate) ? paramDate : null,
  );

  const [leftShare, setLeftShare] = useState(DEFAULT_LEFT_SHARE);
  const [chartShare, setChartShare] = useState(DEFAULT_CHART_SHARE);
  const [tradesShare, setTradesShare] = useState(DEFAULT_TRADES_SHARE);
  const [ladderShare, setLadderShare] = useState(DEFAULT_LADDER_SHARE);

  const [deltaMode, setDeltaMode] = useState<DeltaMode>("tick");
  const [tapeMinWon, setTapeMinWon] = useState(0);
  const [blindMode, setBlindMode] = useState(false);
  const [bookmarks, setBookmarks] = useState<readonly number[]>([]);
  const [loop, setLoop] = useState<LoopRange | null>(null);
  const [zoom, setZoom] = useState<TimelineZoom>("day");
  const [control, setControl] = useState<ReplayEngineControlState>({
    playing: false,
    buffering: false,
    mode: DEFAULT_MODE,
    activeSecond: 9 * 3600,
    loadedSpanCount: 0,
  });

  const workspaceRef = useRef<HTMLDivElement>(null);
  const leftGroupRef = useRef<HTMLDivElement>(null);
  const tapeGroupRef = useRef<HTMLDivElement>(null);
  const rightGroupRef = useRef<HTMLDivElement>(null);
  const headPriceRef = useRef<HTMLSpanElement>(null);
  const headDiffRef = useRef<HTMLSpanElement>(null);
  const headValRef = useRef<HTMLElement>(null);
  const skipSeekSyncRef = useRef(false);

  const searchDialogOpen = useSelectionStore((s) => s.dialog?.kind === "search");
  const openSearch = useSelectionStore((s) => s.openSearch);
  const showToast = useSelectionStore((s) => s.showToast);

  useEffect(() => {
    if (paramSymbol && !isIndexCode(paramSymbol) && paramSymbol !== code) {
      setCode(paramSymbol);
      setRequestedDate(paramDate && /^\d{8}$/.test(paramDate) ? paramDate : null);
    }
  }, [paramSymbol, paramDate, code]);

  const palette = useCanvasPalette();
  const data = useReplayData(code, requestedDate);
  const session = data.session;
  const replayMeta = data.replayMeta;

  const engine = useMemo(() => {
    if (!session) return null;
    return new ReplayEngine({ code, session, meta: replayMeta });
  }, [code, session, replayMeta]);

  const paper = useMemo(() => {
    if (!session) return null;
    return new ReplayPaperEngine();
  }, [code, session]);

  useEffect(() => {
    if (!engine) return;
    setBookmarks([]);
    setLoop(null);
    return () => {
      engine.dispose();
    };
  }, [engine]);

  useEffect(() => {
    if (!engine || !paper) return;
    paper.seedAnchor(engine.getFrame().cursorMs);
    const unsubStep = engine.subscribeMarketStep((step) => {
      paper.onMarketStep(step);
    });
    const unsubSeek = engine.subscribeSeek((event) => {
      if (skipSeekSyncRef.current) return;
      if (event.targetMs < event.previousMs) {
        const undo = paper.onRewind(event.targetMs, event.previousMs, event.fromLoop);
        if (undo !== null) {
          showToast(`${formatReplayClock(event.targetMs / 1000, false)}로 되감아 가상 주문·체결을 시점 복원했습니다`);
        }
      }
    });
    return () => {
      unsubStep();
      unsubSeek();
    };
  }, [engine, paper, showToast]);

  useEffect(() => {
    if (!engine) return;
    return engine.subscribeControl(setControl);
  }, [engine]);

  useEffect(() => {
    engine?.setDeltaMode(deltaMode);
  }, [engine, deltaMode]);

  useEffect(() => {
    engine?.setTapeMinWon(tapeMinWon);
  }, [engine, tapeMinWon]);

  useEffect(() => {
    engine?.setLoop(loop ? { aMs: loop.a * 1000, bMs: loop.b * 1000 } : null);
  }, [engine, loop]);

  useEffect(() => {
    if (!engine || !session) return;
    const prevClose = session.previousClose;
    const applyHead = (frame: ReplayEngineFrame) => {
      const p = frame.price;
      const diff = p !== null && prevClose !== null && prevClose > 0 ? p - prevClose : null;
      const rate = diff !== null && prevClose !== null && prevClose > 0 ? (diff / prevClose) * 100 : null;
      const tone = diff === null ? "" : diff > 0 ? "rp-up" : diff < 0 ? "rp-down" : "";
      if (headPriceRef.current) {
        const cls = tone ? `rp-head-price ${tone}` : "rp-head-price";
        if (headPriceRef.current.className !== cls) headPriceRef.current.className = cls;
        setText(headPriceRef.current, p !== null ? formatPrice(p, false) : "-");
      }
      if (headDiffRef.current) {
        if (diff !== null && rate !== null) {
          headDiffRef.current.hidden = false;
          const cls = tone ? `rp-head-diff ${tone}` : "rp-head-diff";
          if (headDiffRef.current.className !== cls) headDiffRef.current.className = cls;
          setText(headDiffRef.current, `${formatSignedQty(diff)} (${formatPercent(rate)})`);
        } else {
          headDiffRef.current.hidden = true;
        }
      }
      setText(headValRef.current, formatWonCompact(frame.cumVal));
    };
    return engine.subscribeFrame(applyHead);
  }, [engine, session]);

  const updateDate = useCallback(
    (nextDate: string) => {
      setRequestedDate(nextDate);
      setSearchParams({ symbol: code, date: nextDate }, { replace: true });
    },
    [code, setSearchParams],
  );

  const scrubSec = useCallback((sec: number) => {
    engine?.seekSec(sec);
  }, [engine]);

  const togglePlay = useCallback(() => {
    engine?.togglePlay();
  }, [engine]);

  const stepTick = useCallback((dir: -1 | 1) => {
    engine?.stepTick(dir);
  }, [engine]);

  const stepSec = useCallback((delta: number) => {
    engine?.stepSec(delta);
  }, [engine]);

  const changeMode = useCallback((next: PlaybackMode) => {
    engine?.setMode(next);
  }, [engine]);

  const addBookmark = useCallback(() => {
    if (!engine) return;
    const cursorSec = engine.getFrame().cursorMs / 1000;
    setBookmarks((prev) => [...prev, cursorSec]);
    showToast(`${formatReplayClock(cursorSec, false)}에 북마크를 추가했습니다`);
  }, [engine, showToast]);

  const toggleLoop = useCallback(() => {
    if (!engine || !session) return;
    const cursorSec = engine.getFrame().cursorMs / 1000;
    setLoop((prev) => {
      if (prev !== null) {
        paper?.clearLoopAnchor();
        showToast("A-B 구간 반복을 해제했습니다");
        return null;
      }
      paper?.setLoopAnchor();
      const a = Math.max(session.sessionStartSec, cursorSec - 15);
      const b = Math.min(session.sessionEndSec, cursorSec + 25);
      showToast(`A-B 루프 (${formatReplayClock(a, false)} ~ ${formatReplayClock(b, false)})`);
      return { a, b };
    });
  }, [engine, session, paper, showToast]);

  const handleUndoRewind = useCallback(() => {
    if (!engine || !paper) return;
    const undone = paper.undoRewind();
    if (!undone) return;
    skipSeekSyncRef.current = true;
    try {
      engine.seekMs(undone.previousCursorMs);
    } finally {
      skipSeekSyncRef.current = false;
    }
  }, [engine, paper]);

  const jumpMs = useCallback((ms: number) => {
    if (!engine) return;
    engine.setPlaying(false);
    engine.seekMs(ms);
  }, [engine]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (searchDialogOpen) return;

      if (event.key === "/") {
        event.preventDefault();
        openSearch("replay");
        return;
      }
      if (!engine) return;
      if (event.key === " ") {
        event.preventDefault();
        togglePlay();
      } else if (event.key === ",") {
        event.preventDefault();
        stepTick(-1);
      } else if (event.key === ".") {
        event.preventDefault();
        stepTick(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepSec(event.shiftKey ? -10 : -1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        stepSec(event.shiftKey ? 10 : 1);
      } else if (event.key === "PageDown") {
        event.preventDefault();
        stepSec(-60);
      } else if (event.key === "PageUp") {
        event.preventDefault();
        stepSec(60);
      } else if (event.key === "b" || event.key === "B") {
        event.preventDefault();
        addBookmark();
      } else if (event.key === "l" || event.key === "L") {
        event.preventDefault();
        toggleLoop();
      } else if (event.key === "h" || event.key === "H") {
        event.preventDefault();
        setBlindMode((prev) => !prev);
      } else if (event.key === "m" || event.key === "M") {
        event.preventDefault();
        const curMode = engine.getControlState().mode;
        if (curMode.kind === "time") {
          engine.setMode({ kind: "tick", rateHz: 5, filter: "all" });
          showToast("틱 단위 재생 모드로 전환했습니다");
        } else {
          engine.setMode({ kind: "time", speed: 1, skipIdleMs: null });
          showToast("시간 단위 재생 모드로 전환했습니다");
        }
      } else if (/^[1-7]$/.test(event.key)) {
        const idx = Number(event.key) - 1;
        const curMode = engine.getControlState().mode;
        if (curMode.kind === "time" && idx < TIME_REPLAY_SPEEDS.length) {
          const nextSpeed = TIME_REPLAY_SPEEDS[idx]!;
          engine.setMode({ ...curMode, speed: nextSpeed });
          showToast(`재생 배속 ${nextSpeed}x`);
        } else if (curMode.kind === "tick" && idx < TICK_REPLAY_RATES.length) {
          const nextRate = TICK_REPLAY_RATES[idx]!;
          engine.setMode({ ...curMode, rateHz: nextRate });
          showToast(`틱 재생 속도 ${nextRate}틱/s`);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [engine, searchDialogOpen, openSearch, togglePlay, stepTick, stepSec, addBookmark, toggleLoop, showToast]);

  const symbolName = data.symbolInfo?.name ?? code;
  const prevClose = session?.previousClose ?? null;
  const resolution = engine?.getResolution() ?? "minute_only";

  const body = (() => {
    if (data.publicMode) {
      return <EmptyState title="공개 모드에서는 호가 복기를 지원하지 않습니다" />;
    }
    if (data.accessPending) {
      return <Skeleton label="호가 복기 상태를 확인하는 중입니다" />;
    }
    if (!data.available) {
      return <EmptyState title="호가 복기 수집 저장소가 연결되지 않았습니다" />;
    }
    if (data.daysPending) {
      return <Skeleton label="수집된 관측일을 불러오는 중입니다" />;
    }
    if (data.activeDate === null) {
      return <EmptyState title={`${symbolName}의 수집된 호가 복기 날짜가 없습니다`} />;
    }
    if (data.replayPending) {
      return <Skeleton label={`${formatShortDay(data.activeDate)} 호가 복기 자료를 불러오는 중입니다`} />;
    }
    if (data.replayFailed) {
      return <ErrorState message="호가 복기 자료를 불러오지 못했습니다" retry={data.retryReplay} />;
    }
    const coverage = data.replayMeta?.coverage ?? data.replayDay?.coverage;
    if (coverage === "symbol_not_collected") {
      return <EmptyState title="이 종목은 수집 대상이 아닙니다" />;
    }
    if (coverage === "day_not_collected" || !session || !engine || !paper) {
      return <EmptyState title="이 날의 수집 호가 자료가 없습니다" />;
    }

    return (
      <div className="rp-stage">
        <div ref={workspaceRef} className="rp-workspace" data-testid="replay-workspace">
          <div
            ref={leftGroupRef}
            className="rp-split-row rp-left-group"
            style={{ flexGrow: leftShare, flexShrink: 1, flexBasis: 0 }}
          >
            <div
              className="rp-pane-slot"
              data-testid="replay-slot-chart"
              style={{ flexGrow: chartShare, flexShrink: 1, flexBasis: 0 }}
            >
              <ReplayCharts
                session={session}
                engine={engine}
                paper={paper}
                blindMode={blindMode}
                bookmarks={bookmarks}
                palette={palette}
                onScrub={scrubSec}
              />
            </div>

            <ReplaySplitter
              orientation="vertical"
              value={chartShare}
              min={0.3}
              max={0.82}
              defaultValue={DEFAULT_CHART_SHARE}
              containerRef={leftGroupRef}
              label="차트와 체결 영역 너비 조절"
              testId="replay-splitter-chart"
              onChange={setChartShare}
            />

            <div
              ref={tapeGroupRef}
              className="rp-split-row rp-tape-group"
              style={{ flexGrow: 1 - chartShare, flexShrink: 1, flexBasis: 0 }}
            >
              <div
                className="rp-pane-slot"
                data-testid="replay-slot-trades"
                style={{ flexGrow: tradesShare, flexShrink: 1, flexBasis: 0 }}
              >
                <ReplayTradesPane
                  engine={engine}
                  previousClose={session.previousClose}
                  tapeMinWon={tapeMinWon}
                  onTapeMinWon={setTapeMinWon}
                  onJumpMs={jumpMs}
                />
              </div>

              <ReplaySplitter
                orientation="vertical"
                value={tradesShare}
                min={0.25}
                max={0.75}
                defaultValue={DEFAULT_TRADES_SHARE}
                containerRef={tapeGroupRef}
                label="체결창과 프로그램 체결창 너비 조절"
                testId="replay-splitter-tape"
                onChange={setTradesShare}
              />

              <div
                className="rp-pane-slot"
                data-testid="replay-slot-program"
                style={{ flexGrow: 1 - tradesShare, flexShrink: 1, flexBasis: 0 }}
              >
                <ReplayProgramPane
                  engine={engine}
                  previousClose={session.previousClose}
                  onJumpMs={jumpMs}
                />
              </div>
            </div>
          </div>

          <ReplaySplitter
            orientation="vertical"
            value={leftShare}
            min={0.45}
            max={0.84}
            defaultValue={DEFAULT_LEFT_SHARE}
            containerRef={workspaceRef}
            label="좌측 영역과 우측 영역 너비 조절"
            testId="replay-splitter-main"
            onChange={setLeftShare}
          />

          <div
            ref={rightGroupRef}
            className="rp-split-col rp-right-group"
            style={{ flexGrow: 1 - leftShare, flexShrink: 1, flexBasis: 0 }}
          >
            <div
              className="rp-pane-slot"
              data-testid="replay-slot-ladder"
              style={{ flexGrow: ladderShare, flexShrink: 1, flexBasis: 0 }}
            >
              <ReplayLadder
                engine={engine}
                paper={paper}
                previousClose={session.previousClose}
                tickStepOf={session.tickStepOf}
                deltaMode={deltaMode}
                onDeltaMode={setDeltaMode}
                onUndoRewind={handleUndoRewind}
              />
            </div>

            <ReplaySplitter
              orientation="horizontal"
              value={ladderShare}
              min={0.28}
              max={0.76}
              defaultValue={DEFAULT_LADDER_SHARE}
              containerRef={rightGroupRef}
              label="호가주문창과 거래원 높이 조절"
              testId="replay-splitter-right"
              onChange={setLadderShare}
            />

            <div
              className="rp-pane-slot"
              data-testid="replay-slot-brokers"
              style={{ flexGrow: 1 - ladderShare, flexShrink: 1, flexBasis: 0 }}
            >
              <ReplayBrokersPane
                engine={engine}
                paper={paper}
                dayStartUnix={session.dayStartUnix}
                activeSecond={control.activeSecond}
                blindMode={blindMode}
                onJumpMs={jumpMs}
                brokerDay={data.brokerDay}
                bars1m={data.bars1m}
              />
            </div>
          </div>
        </div>

        <ReplayDeck
          session={session}
          engine={engine}
          paper={paper}
          playing={control.playing}
          buffering={control.buffering}
          mode={control.mode}
          bookmarks={bookmarks}
          loop={loop}
          zoom={zoom}
          palette={palette}
          onTogglePlay={togglePlay}
          onStepTick={stepTick}
          onStepSec={stepSec}
          onMode={changeMode}
          onAddBookmark={addBookmark}
          onToggleLoop={toggleLoop}
          onZoom={setZoom}
          onScrub={scrubSec}
        />
      </div>
    );
  })();

  return (
    <PageFrame title="호가 복기" fullWidth hideLinkColorPicker>
      <div className="rp-root" data-testid="replay-page">
        <div className="rp-context-bar">
          <button
            type="button"
            className="rp-symbol-btn"
            data-testid="replay-symbol-picker"
            aria-haspopup="dialog"
            title="복기 종목 전환 (/)"
            onClick={() => openSearch("replay")}
          >
            <span className="rp-symbol-name">{symbolName}</span>
            <span className="rp-symbol-code rp-mono">{code}</span>
            <kbd>/</kbd>
          </button>

          <ReplayDatePicker
            days={data.days}
            activeDate={data.activeDate}
            onSelect={updateDate}
          />

          {session && (
            <div className="rp-head-quote rp-mono">
              <span ref={headPriceRef} className="rp-head-price" data-testid="replay-head-price">-</span>
              <span ref={headDiffRef} className="rp-head-diff" data-testid="replay-head-diff" hidden />
              <div className="rp-head-meta">
                <span>기준가 <b data-testid="replay-prev-close">{prevClose !== null ? formatPrice(prevClose, false) : "-"}</b></span>
                <span>누적대금 <b ref={headValRef}>-</b></span>
                <span>커버리지 <b>{`${session.coveragePct.toFixed(1)}%`}</b></span>
              </div>
            </div>
          )}

          <div className="rp-context-right">
            <span className="rp-badge-mini" data-testid="replay-resolution-badge" data-resolution={resolution}>
              {resolution === "tick" ? "통합 · 틱 복기" : "장중 1분 요약 · 마감 후 틱 복기"}
            </span>
            {session && (
              <button
                type="button"
                className="rp-flat-btn"
                data-testid="replay-blind-btn"
                aria-pressed={blindMode}
                title="미래 봉 가리기 (H)"
                onClick={() => setBlindMode((prev) => !prev)}
              >
                <span>미래 봉 가리기</span>
                <kbd>H</kbd>
              </button>
            )}
          </div>
        </div>

        <div className="rp-body">{body}</div>
      </div>
    </PageFrame>
  );
}
