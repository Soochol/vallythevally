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
import { type LoopRange, ReplayDeck, type TimelineZoom } from "./ReplayDeck";
import { ReplayLadder } from "./ReplayLadder";
import {
  clampCursorSec,
  computeLadderSnapshot,
  type DeltaMode,
  filterRecentTrades,
  formatReplayClock,
  formatShortDay,
  formatSignedQty,
  formatWonCompact,
  frameIndexAt,
  REPLAY_SPEEDS,
  stepTickSec,
} from "./replayModel";
import { ReplaySymbolDialog } from "./ReplaySymbolDialog";
import { ReplayTapeAndBrokers } from "./ReplayTapeAndBrokers";
import { useReplayData } from "./useReplayData";
import "./replayPage.css";

const DEFAULT_SYMBOL: SymbolCode = "005930";
const MAX_VISIBLE_DATES = 6;
const SPEED_BY_KEY: Readonly<Record<string, number>> = {
  "1": REPLAY_SPEEDS[0],
  "2": REPLAY_SPEEDS[1],
  "3": REPLAY_SPEEDS[2],
  "4": REPLAY_SPEEDS[3],
  "5": REPLAY_SPEEDS[4],
  "6": REPLAY_SPEEDS[5],
};

function initialSymbol(param: string | null): SymbolCode {
  if (param && !isIndexCode(param)) return param;
  const activeId = useSelectionStore.getState().activeCell;
  const activeChart = chartWindows(useLayoutStore.getState().layout).find((cell) => cell.id === activeId);
  if (activeChart && !isIndexCode(activeChart.symbol)) return activeChart.symbol;
  const recent = useUiStore.getState().prefs.recentSymbols.find((code) => !isIndexCode(code));
  return recent ?? DEFAULT_SYMBOL;
}

export function ReplayPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [code, setCode] = useState<SymbolCode>(() => initialSymbol(searchParams.get("symbol")));
  const [requestedDate, setRequestedDate] = useState<string | null>(() => {
    const raw = searchParams.get("date");
    return raw && /^\d{8}$/.test(raw) ? raw : null;
  });
  const [symbolDialogOpen, setSymbolDialogOpen] = useState(false);

  const [cursorSec, setCursorSec] = useState(9 * 3600);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [deltaMode, setDeltaMode] = useState<DeltaMode>("tick");
  const [tapeMinWon, setTapeMinWon] = useState(0);
  const [blindMode, setBlindMode] = useState(false);
  const [bookmarks, setBookmarks] = useState<readonly number[]>([]);
  const [loop, setLoop] = useState<LoopRange | null>(null);
  const [zoom, setZoom] = useState<TimelineZoom>("day");

  const palette = useCanvasPalette();
  const showToast = useSelectionStore((s) => s.showToast);
  const data = useReplayData(code, requestedDate);
  const session = data.session;

  const sessionKey = session ? `${code}-${session.date}` : "";
  const initializedKeyRef = useRef("");

  useEffect(() => {
    if (!session || sessionKey === initializedKeyRef.current) return;
    initializedKeyRef.current = sessionKey;
    const firstFrameSec = session.frames[0]?.t ?? session.sessionStartSec;
    setCursorSec(firstFrameSec);
    setPlaying(false);
    setBookmarks([]);
    setLoop(null);
  }, [session, sessionKey]);

  const updateSymbol = useCallback(
    (nextCode: SymbolCode) => {
      setCode(nextCode);
      setRequestedDate(null);
      setPlaying(false);
      setSearchParams({ symbol: nextCode }, { replace: true });
    },
    [setSearchParams],
  );

  const updateDate = useCallback(
    (nextDate: string) => {
      setRequestedDate(nextDate);
      setPlaying(false);
      setSearchParams({ symbol: code, date: nextDate }, { replace: true });
    },
    [code, setSearchParams],
  );

  const setClampedCursor = useCallback(
    (sec: number) => {
      if (!session) return;
      setCursorSec(clampCursorSec(sec, session.sessionStartSec, session.sessionEndSec));
    },
    [session],
  );

  const togglePlay = useCallback(() => {
    if (!session) return;
    setPlaying((prev) => {
      if (!prev && cursorSec >= session.sessionEndSec - 1) {
        setCursorSec(session.frames[0]?.t ?? session.sessionStartSec);
      }
      return !prev;
    });
  }, [session, cursorSec]);

  const stepTick = useCallback(
    (dir: -1 | 1) => {
      if (!session) return;
      setPlaying(false);
      setCursorSec((prev) => stepTickSec(session.frames, prev, dir));
    },
    [session],
  );

  const stepSec = useCallback(
    (delta: number) => {
      if (!session) return;
      setCursorSec((prev) => clampCursorSec(prev + delta, session.sessionStartSec, session.sessionEndSec));
    },
    [session],
  );

  const addBookmark = useCallback(() => {
    if (!session) return;
    setBookmarks((prev) => [...prev, cursorSec]);
    showToast(`${formatReplayClock(cursorSec, false)}에 북마크를 추가했습니다`);
  }, [session, cursorSec, showToast]);

  const toggleLoop = useCallback(() => {
    if (!session) return;
    setLoop((prev) => {
      if (prev !== null) {
        showToast("A-B 구간 반복을 해제했습니다");
        return null;
      }
      const a = Math.max(session.sessionStartSec, cursorSec - 15);
      const b = Math.min(session.sessionEndSec, cursorSec + 25);
      showToast(`A-B 루프 (${formatReplayClock(a, false)} ~ ${formatReplayClock(b, false)})`);
      return { a, b };
    });
  }, [session, cursorSec, showToast]);

  useEffect(() => {
    if (!playing || !session) return;
    let rafId = 0;
    let lastTs = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.15, (now - lastTs) / 1000);
      lastTs = now;
      setCursorSec((prev) => {
        const next = prev + dt * speed;
        if (loop && next >= loop.b) return loop.a;
        if (next >= session.sessionEndSec - 0.1) {
          setPlaying(false);
          return session.sessionEndSec - 0.1;
        }
        return next;
      });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [playing, session, speed, loop]);

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
      if (!session) return;
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
      } else if (event.key in SPEED_BY_KEY) {
        const nextSpeed = SPEED_BY_KEY[event.key]!;
        setSpeed(nextSpeed);
        showToast(`재생 배속 ${nextSpeed}x`);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [session, symbolDialogOpen, togglePlay, stepTick, stepSec, addBookmark, toggleLoop, showToast]);

  const frameIdx = useMemo(() => (session ? frameIndexAt(session.frames, cursorSec) : -1), [session, cursorSec]);
  const currentFrame = session && frameIdx >= 0 ? (session.frames[frameIdx] ?? null) : null;
  const ladderSnapshot = useMemo(
    () => (session ? computeLadderSnapshot(session, frameIdx, deltaMode) : null),
    [session, frameIdx, deltaMode],
  );
  const tradeSummary = useMemo(
    () => (session ? filterRecentTrades(session.frames, frameIdx, tapeMinWon) : { rows: [], net1mQty: 0, whaleBuy: 0, whaleSell: 0 }),
    [session, frameIdx, tapeMinWon],
  );

  const recentDates = useMemo(() => data.days.slice(-MAX_VISIBLE_DATES).reverse(), [data.days]);
  const symbolName = data.symbolInfo?.name ?? code;
  const headPrice = currentFrame?.price ?? null;
  const prevClose = session?.previousClose ?? null;
  const headDiff = headPrice !== null && prevClose !== null && prevClose > 0 ? headPrice - prevClose : null;
  const headRate = headDiff !== null && prevClose !== null && prevClose > 0 ? (headDiff / prevClose) * 100 : null;
  const headTone = headDiff === null ? "" : headDiff > 0 ? "rp-up" : headDiff < 0 ? "rp-down" : "";

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
    if (data.replayDay?.coverage === "symbol_not_collected") {
      return <EmptyState title="이 종목은 수집 대상이 아닙니다" />;
    }
    if (data.replayDay?.coverage === "day_not_collected" || !session || !ladderSnapshot) {
      return <EmptyState title="이 날의 수집 호가 자료가 없습니다" />;
    }

    return (
      <div className="rp-stage">
        <div className="rp-workspace">
          <ReplayCharts
            session={session}
            frame={currentFrame}
            cursorSec={cursorSec}
            blindMode={blindMode}
            bookmarks={bookmarks}
            palette={palette}
            onScrub={setClampedCursor}
          />
          <ReplayLadder
            snapshot={ladderSnapshot}
            previousClose={session.previousClose}
            deltaMode={deltaMode}
            onDeltaMode={setDeltaMode}
          />
          <ReplayTapeAndBrokers
            frame={currentFrame}
            previousClose={session.previousClose}
            dayStartUnix={session.dayStartUnix}
            cursorSec={cursorSec}
            tradeSummary={tradeSummary}
            tapeMinWon={tapeMinWon}
            onTapeMinWon={setTapeMinWon}
            onJumpSec={(sec) => {
              setPlaying(false);
              setClampedCursor(sec);
            }}
            brokerDay={data.brokerDay}
            bars1m={data.bars1m}
          />
        </div>

        <ReplayDeck
          session={session}
          frame={currentFrame}
          cursorSec={cursorSec}
          playing={playing}
          speed={speed}
          bookmarks={bookmarks}
          loop={loop}
          zoom={zoom}
          palette={palette}
          onTogglePlay={togglePlay}
          onStepTick={stepTick}
          onStepSec={stepSec}
          onSpeed={setSpeed}
          onAddBookmark={addBookmark}
          onToggleLoop={toggleLoop}
          onZoom={setZoom}
          onScrub={setClampedCursor}
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

          {recentDates.length > 0 && (
            <div className="rp-date-pills" role="group" aria-label="관측일 선택" data-testid="replay-date-pills">
              {recentDates.map((day) => (
                <button
                  key={day}
                  type="button"
                  className="rp-date-pill rp-mono"
                  aria-pressed={day === data.activeDate}
                  onClick={() => updateDate(day)}
                >
                  {formatShortDay(day)}
                </button>
              ))}
            </div>
          )}

          {session && (
            <div className="rp-head-quote rp-mono">
              <span className={`rp-head-price ${headTone}`} data-testid="replay-head-price">
                {headPrice !== null ? formatPrice(headPrice, false) : "-"}
              </span>
              {headDiff !== null && headRate !== null && (
                <span className={`rp-head-diff ${headTone}`} data-testid="replay-head-diff">
                  {`${formatSignedQty(headDiff)} (${formatPercent(headRate)})`}
                </span>
              )}
              <div className="rp-head-meta">
                <span>기준가 <b data-testid="replay-prev-close">{prevClose !== null ? formatPrice(prevClose, false) : "-"}</b></span>
                <span>누적대금 <b>{currentFrame ? formatWonCompact(currentFrame.cumVal) : "-"}</b></span>
                <span>커버리지 <b>{`${session.coveragePct.toFixed(1)}%`}</b></span>
              </div>
            </div>
          )}

          <div className="rp-context-right">
            <span className="rp-badge-mini">통합 · 수집 호가</span>
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
