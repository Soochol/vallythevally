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
import { ReplayCharts } from "./ReplayCharts";
import { ReplayDatePicker } from "./ReplayDatePicker";
import { type LoopRange, ReplayDeck, type TimelineZoom } from "./ReplayDeck";
import { ReplayLadder } from "./ReplayLadder";
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
import { ReplaySymbolDialog } from "./ReplaySymbolDialog";
import { ReplayTapeAndBrokers } from "./ReplayTapeAndBrokers";
import { useReplayData } from "./useReplayData";
import "./replayPage.css";

const DEFAULT_SYMBOL: SymbolCode = "005930";
const DEFAULT_MODE: PlaybackMode = { kind: "time", speed: 1, skipIdleMs: null };

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
  const [code, setCode] = useState<SymbolCode>(() => initialSymbol(searchParams.get("symbol")));
  const [requestedDate, setRequestedDate] = useState<string | null>(() => {
    const raw = searchParams.get("date");
    return raw && /^\d{8}$/.test(raw) ? raw : null;
  });
  const [symbolDialogOpen, setSymbolDialogOpen] = useState(false);

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

  const headPriceRef = useRef<HTMLSpanElement>(null);
  const headDiffRef = useRef<HTMLSpanElement>(null);
  const headValRef = useRef<HTMLElement>(null);
  const skipSeekSyncRef = useRef(false);

  const palette = useCanvasPalette();
  const showToast = useSelectionStore((s) => s.showToast);
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

  const updateSymbol = useCallback(
    (nextCode: SymbolCode) => {
      setCode(nextCode);
      setRequestedDate(null);
      setSearchParams({ symbol: nextCode }, { replace: true });
    },
    [setSearchParams],
  );

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (symbolDialogOpen) return;

      if (event.key === "/") {
        event.preventDefault();
        setSymbolDialogOpen(true);
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
  }, [engine, symbolDialogOpen, togglePlay, stepTick, stepSec, addBookmark, toggleLoop, showToast]);

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
        <div className="rp-workspace">
          <ReplayCharts
            session={session}
            engine={engine}
            paper={paper}
            blindMode={blindMode}
            bookmarks={bookmarks}
            palette={palette}
            onScrub={scrubSec}
          />
          <ReplayLadder
            engine={engine}
            paper={paper}
            previousClose={session.previousClose}
            tickStepOf={session.tickStepOf}
            deltaMode={deltaMode}
            onDeltaMode={setDeltaMode}
            onUndoRewind={handleUndoRewind}
          />
          <ReplayTapeAndBrokers
            engine={engine}
            paper={paper}
            previousClose={session.previousClose}
            dayStartUnix={session.dayStartUnix}
            activeSecond={control.activeSecond}
            tapeMinWon={tapeMinWon}
            onTapeMinWon={setTapeMinWon}
            onJumpMs={(ms) => {
              engine.setPlaying(false);
              engine.seekMs(ms);
            }}
            brokerDay={data.brokerDay}
            bars1m={data.bars1m}
          />
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
    <PageFrame title="호가 복기">
      <div className="rp-root" data-testid="replay-page">
        <div className="rp-context-bar">
          <button
            type="button"
            className="rp-symbol-btn"
            data-testid="replay-symbol-picker"
            title="복기 종목 전환 (/)"
            onClick={() => setSymbolDialogOpen(true)}
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

      <ReplaySymbolDialog
        open={symbolDialogOpen}
        currentCode={code}
        onSelect={updateSymbol}
        onClose={() => setSymbolDialogOpen(false)}
      />
    </PageFrame>
  );
}
