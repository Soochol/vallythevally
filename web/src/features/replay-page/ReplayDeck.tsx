import { type PointerEvent, useEffect, useRef, useState } from "react";
import { formatPercent, formatPrice } from "../../lib/format";
import { type CanvasPalette } from "./canvasTheme";
import {
  type PlaybackMode,
  type ReplayEngine,
  type ReplayEngineFrame,
  TICK_REPLAY_RATES,
  type TickEventFilter,
  type TickReplayRate,
  TIME_REPLAY_SPEEDS,
  type TimeReplaySpeed,
} from "./replayEngine";
import {
  formatReplayClock,
  type ReplaySession,
} from "./replayModel";
import type { ReplayPaperEngine } from "./replayPaperEngine";

export type TimelineZoom = "day" | "10m";

export interface LoopRange {
  readonly a: number;
  readonly b: number;
}

interface Props {
  readonly session: ReplaySession;
  readonly engine: ReplayEngine;
  readonly paper?: ReplayPaperEngine;
  readonly playing: boolean;
  readonly buffering: boolean;
  readonly mode: PlaybackMode;
  readonly bookmarks: readonly number[];
  readonly loop: LoopRange | null;
  readonly zoom: TimelineZoom;
  readonly palette: CanvasPalette;
  readonly onTogglePlay: () => void;
  readonly onStepTick: (dir: -1 | 1) => void;
  readonly onStepSec: (deltaSec: number) => void;
  readonly onMode: (mode: PlaybackMode) => void;
  readonly onAddBookmark: () => void;
  readonly onToggleLoop: () => void;
  readonly onZoom: (zoom: TimelineZoom) => void;
  readonly onScrub: (sec: number) => void;
}

const IDLE_SKIP_CHOICES: readonly { readonly value: number | null; readonly label: string }[] = [
  { value: null, label: "끄기" },
  { value: 3_000, label: "3초+" },
  { value: 5_000, label: "5초+" },
];

const TICK_FILTER_CHOICES: readonly { readonly value: TickEventFilter; readonly label: string }[] = [
  { value: "all", label: "전체" },
  { value: "trade", label: "체결만" },
  { value: "book", label: "호가만" },
];

function timelineBounds(session: ReplaySession, cursorSec: number, zoom: TimelineZoom) {
  if (zoom === "day") return { start: session.sessionStartSec, end: session.sessionEndSec };
  const half = 300;
  let start = Math.max(session.sessionStartSec, cursorSec - half);
  const end = Math.min(session.sessionEndSec, start + half * 2);
  start = Math.max(session.sessionStartSec, end - half * 2);
  return { start, end };
}

function setText(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

function formatDeltaValue(ms: number): string {
  if (ms <= 0) return "0ms";
  if (ms >= 1000) return `+${(ms / 1000).toFixed(2)}s`;
  return `+${Math.round(ms).toLocaleString("ko-KR")}ms`;
}

export function ReplayDeck({
  session,
  engine,
  paper,
  playing,
  buffering,
  mode,
  bookmarks,
  loop,
  zoom,
  palette,
  onTogglePlay,
  onStepTick,
  onStepSec,
  onMode,
  onAddBookmark,
  onToggleLoop,
  onZoom,
  onScrub,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const sessionPillRef = useRef<HTMLSpanElement>(null);
  const deltaPillRef = useRef<HTMLSpanElement>(null);
  const deltaValRef = useRef<HTMLSpanElement>(null);
  const skipPillRef = useRef<HTMLSpanElement>(null);
  const draggingRef = useRef(false);
  const lastCursorSecRef = useRef(session.sessionStartSec);
  const hoverSecRef = useRef<number | null>(null);
  const [hoverSec, setHoverSec] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);
  const [resizeTick, setResizeTick] = useState(0);

  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setResizeTick((t) => t + 1));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    hoverSecRef.current = hoverSec;
  }, [hoverSec]);

  useEffect(() => {
    const paint = (frame: ReplayEngineFrame) => {
      const cursorSec = frame.cursorMs / 1000;
      lastCursorSecRef.current = cursorSec;

      setText(clockRef.current, formatReplayClock(cursorSec, true));

      if (sessionPillRef.current) {
        const sessionKind = frame.inGap ? "gap" : frame.singlePrice ? "vi" : "open";
        const sessionLabel = frame.inGap ? "수집 끊김" : frame.singlePrice ? "단일가" : "정규장";
        sessionPillRef.current.setAttribute("data-kind", sessionKind);
        setText(sessionPillRef.current, sessionLabel);
      }

      if (deltaPillRef.current) {
        if (frame.resolution === "tick" && mode.kind === "tick") {
          deltaPillRef.current.hidden = false;
          setText(deltaValRef.current, formatDeltaValue(frame.deltaMs));
        } else {
          deltaPillRef.current.hidden = true;
        }
      }

      if (skipPillRef.current) {
        if (frame.skipNotice !== null) {
          skipPillRef.current.hidden = false;
          setText(skipPillRef.current, `공백 스킵 +${(frame.skipNotice.skippedMs / 1000).toFixed(1)}s`);
        } else {
          skipPillRef.current.hidden = true;
        }
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const { start, end } = timelineBounds(session, cursorSec, zoom);
      const span = Math.max(1, end - start);
      const xOfSec = (sec: number) => ((sec - start) / span) * w;

      if (session.spans.length > 0) {
        let maxDensity = 1;
        for (const sp of session.spans) {
          const density = sp.bookRows + sp.tradeRows;
          if (density > maxDensity) maxDensity = density;
        }
        for (const sp of session.spans) {
          const s0 = sp.startMinute * 60;
          const s1 = s0 + 300;
          if (s1 < start || s0 > end) continue;
          const density = sp.bookRows + sp.tradeRows;
          const ratio = density / maxDensity;
          const x0 = xOfSec(Math.max(start, s0));
          const x1 = xOfSec(Math.min(end, s1));
          ctx.fillStyle = palette.accentSoft;
          ctx.globalAlpha = 0.2 + ratio * 0.65;
          ctx.fillRect(x0, h - Math.max(3, ratio * (h - 10)), Math.max(1.5, x1 - x0 - 0.5), Math.max(3, ratio * (h - 10)));
        }
        ctx.globalAlpha = 1;
      }

      let maxV = 1;
      let minP = Infinity;
      let maxP = -Infinity;
      for (const b of session.minutes) {
        if (b.volume > maxV) maxV = b.volume;
        if (b.close !== null) {
          if (b.close < minP) minP = b.close;
          if (b.close > maxP) maxP = b.close;
        }
      }

      for (const b of session.minutes) {
        if (b.sec + 60 < start || b.sec > end) continue;
        const x0 = xOfSec(b.sec);
        const x1 = xOfSec(b.sec + 60);
        const bh = (b.volume / maxV) * (h - 10);
        const isUp = b.open !== null && b.close !== null ? b.close >= b.open : true;
        ctx.fillStyle = isUp ? palette.upVol : palette.downVol;
        ctx.fillRect(x0, h - bh, Math.max(1.2, x1 - x0 - 0.5), bh);
      }

      if (Number.isFinite(minP) && Number.isFinite(maxP)) {
        ctx.beginPath();
        ctx.strokeStyle = palette.text2;
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = 1.2;
        let began = false;
        for (const b of session.minutes) {
          if (b.close === null || b.sec + 60 < start || b.sec > end) continue;
          const x = xOfSec(b.sec + 30);
          const y = 6 + (1 - (b.close - minP) / Math.max(1, maxP - minP)) * (h - 14);
          if (!began) {
            ctx.moveTo(x, y);
            began = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      for (const sw of session.singlePriceWindows) {
        if (sw.endSec < start || sw.startSec > end) continue;
        const x0 = xOfSec(Math.max(start, sw.startSec));
        const x1 = Math.max(x0 + 4, xOfSec(Math.min(end, sw.endSec)));
        ctx.fillStyle = palette.warningSoft;
        ctx.fillRect(x0, 0, x1 - x0, h);
      }

      for (const gw of session.gapWindows) {
        if (gw.endSec < start || gw.startSec > end) continue;
        const x0 = xOfSec(Math.max(start, gw.startSec));
        const x1 = Math.max(x0 + 4, xOfSec(Math.min(end, gw.endSec)));
        ctx.fillStyle = palette.dangerSoft;
        ctx.fillRect(x0, 0, x1 - x0, h);
      }

      if (loop) {
        const x0 = xOfSec(Math.max(start, loop.a));
        const x1 = xOfSec(Math.min(end, loop.b));
        ctx.fillStyle = palette.accentSoft;
        ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);
        ctx.strokeStyle = palette.accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x0, 0);
        ctx.lineTo(x0, h);
        ctx.moveTo(x1, 0);
        ctx.lineTo(x1, h);
        ctx.stroke();
      }

      for (const bm of bookmarks) {
        if (bm < start || bm > end) continue;
        const bx = xOfSec(bm);
        ctx.fillStyle = palette.accent;
        ctx.fillRect(bx - 3, 2, 6, 6);
        ctx.fillRect(bx - 0.75, 8, 1.5, h - 8);
      }

      if (paper) {
        for (const fill of paper.getFills()) {
          const fillSec = fill.ms / 1000;
          if (fillSec < start || fillSec > end) continue;
          const fx = xOfSec(fillSec);
          ctx.fillStyle = fill.side === "buy" ? palette.up : palette.down;
          ctx.beginPath();
          ctx.arc(fx, fill.side === "buy" ? h - 8 : 8, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      const px = xOfSec(cursorSec);
      ctx.fillStyle = palette.seriesFill;
      ctx.fillRect(0, 0, Math.max(0, px), h);

      const hSec = hoverSecRef.current;
      if (hSec !== null && hSec >= start && hSec <= end) {
        const hx = xOfSec(hSec);
        ctx.strokeStyle = palette.lineStrong;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hx, 0);
        ctx.lineTo(hx, h);
        ctx.stroke();
      }

      ctx.fillStyle = palette.accent;
      ctx.fillRect(px - 1.25, 0, 2.5, h);
      ctx.beginPath();
      ctx.arc(px, 6, 4, 0, Math.PI * 2);
      ctx.fill();
    };

    const unsubFrame = engine.subscribeFrame(paint);
    const unsubPaper = paper ? paper.subscribe(() => paint(engine.getFrame())) : undefined;
    return () => {
      unsubFrame();
      unsubPaper?.();
    };
  }, [session, engine, paper, mode.kind, bookmarks, loop, zoom, palette, resizeTick, hoverSec]);

  const { start, end } = timelineBounds(session, lastCursorSecRef.current, zoom);
  const span = Math.max(1, end - start);

  const secFromEvent = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    const bounds = timelineBounds(session, lastCursorSecRef.current, zoom);
    return bounds.start + ratio * Math.max(1, bounds.end - bounds.start);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    onScrub(secFromEvent(event));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const sec = secFromEvent(event);
    setHoverSec(sec);
    setHoverX(Math.max(60, Math.min(rect.width - 60, event.clientX - rect.left)));
    if (draggingRef.current) onScrub(sec);
  };

  const onPointerUp = () => {
    draggingRef.current = false;
  };

  const onPointerLeave = () => {
    setHoverSec(null);
  };

  const hoverMinute = hoverSec !== null ? Math.floor(hoverSec / 60) : null;
  const hoverBar = hoverMinute !== null ? session.minutes.find((m) => m.minute === hoverMinute) : null;
  const hoverPrice = hoverBar?.close ?? null;
  const hoverRate = hoverPrice !== null && session.previousClose
    ? ((hoverPrice - session.previousClose) / session.previousClose) * 100
    : null;

  const axisLabels = Array.from({ length: 8 }, (_, i) => formatReplayClock(start + (span * i) / 7, false));

  const switchToTime = () => {
    if (mode.kind === "time") return;
    onMode({ kind: "time", speed: 1, skipIdleMs: null });
  };

  const switchToTick = () => {
    if (mode.kind === "tick") return;
    onMode({ kind: "tick", rateHz: 5, filter: "all" });
  };

  const setTimeSpeed = (speed: TimeReplaySpeed) => {
    onMode({ kind: "time", speed, skipIdleMs: mode.kind === "time" ? mode.skipIdleMs : null });
  };

  const setIdleSkip = (skipIdleMs: number | null) => {
    onMode({ kind: "time", speed: mode.kind === "time" ? mode.speed : 1, skipIdleMs });
  };

  const setTickRate = (rateHz: TickReplayRate) => {
    onMode({ kind: "tick", rateHz, filter: mode.kind === "tick" ? mode.filter : "all" });
  };

  const setTickFilter = (filter: TickEventFilter) => {
    onMode({ kind: "tick", rateHz: mode.kind === "tick" ? mode.rateHz : 5, filter });
  };

  return (
    <section className="rp-deck" aria-label="호가 복기 재생 제어" data-testid="replay-deck">
      <div className="rp-deck-controls">
        <div className="rp-deck-left">
          <div className="rp-clock-box">
            <span ref={clockRef} className="rp-clock-val rp-mono" data-testid="replay-clock">09:00:00.000</span>
            <span ref={sessionPillRef} className="rp-session-pill" data-kind="open">정규장</span>
            <span ref={deltaPillRef} className="rp-dt-pill rp-mono" data-testid="replay-tick-dt" hidden>
              <span className="rp-dt-lbl">Δt</span>
              <span ref={deltaValRef} className="rp-dt-val">0ms</span>
            </span>
            <span ref={skipPillRef} className="rp-skip-pill rp-mono" data-testid="replay-skip-notice" hidden />
            {buffering && <span className="rp-buf-pill" data-testid="replay-buffering">구간 불러오는 중</span>}
          </div>
        </div>

        <div className="rp-deck-center" data-testid="replay-deck-center">
          <div className="rp-seg" role="group" aria-label="재생 방식" data-testid="replay-mode-switch">
            <button type="button" aria-pressed={mode.kind === "time"} title="실제 장중 타임스탬프 간격대로 배속 재생 (M)" onClick={switchToTime}>
              시간 단위
            </button>
            <button type="button" aria-pressed={mode.kind === "tick"} title="틱 1건당 일정 속도로 정밀 재생 (M)" onClick={switchToTick}>
              틱 단위
            </button>
          </div>

          <div className="rp-transport" role="group" aria-label="재생 제어">
            <button type="button" className="rp-tbtn" title="-1분 (PageDown)" onClick={() => onStepSec(-60)}>-1m</button>
            <button type="button" className="rp-tbtn" title="-1초 (←)" onClick={() => onStepSec(-1)}>-1s</button>
            <button type="button" className="rp-tbtn" title="이전 틱 (,)" onClick={() => onStepTick(-1)}>-1틱</button>
            <button
              type="button"
              className="rp-tbtn rp-play-btn"
              data-testid="replay-play"
              data-playing={playing ? "true" : "false"}
              title="재생/일시정지 (Space)"
              onClick={onTogglePlay}
            >
              {playing ? (
                <svg className="rp-play-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <rect x="2" y="1.5" width="3" height="9" rx="0.8" fill="currentColor" />
                  <rect x="7" y="1.5" width="3" height="9" rx="0.8" fill="currentColor" />
                </svg>
              ) : (
                <svg className="rp-play-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M2.5 1.5L10.5 6L2.5 10.5V1.5Z" fill="currentColor" />
                </svg>
              )}
              <span>{playing ? "멈춤" : "재생"}</span>
            </button>
            <button type="button" className="rp-tbtn" title="다음 틱 (.)" onClick={() => onStepTick(1)}>+1틱</button>
            <button type="button" className="rp-tbtn" title="+1초 (→)" onClick={() => onStepSec(1)}>+1s</button>
            <button type="button" className="rp-tbtn" title="+1분 (PageUp)" onClick={() => onStepSec(60)}>+1m</button>
          </div>

          {mode.kind === "time" ? (
            <div className="rp-mode-controls" data-testid="replay-time-controls">
              <div className="rp-seg rp-mono" role="group" aria-label="배속 선택">
                {TIME_REPLAY_SPEEDS.map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    aria-pressed={mode.speed === sp}
                    onClick={() => setTimeSpeed(sp)}
                  >
                    {`${sp}x`}
                  </button>
                ))}
              </div>
              <div className="rp-seg" role="group" aria-label="공백 구간 자동 스킵" data-testid="replay-idle-skip">
                <span className="rp-seg-label">공백 스킵</span>
                {IDLE_SKIP_CHOICES.map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    aria-pressed={mode.skipIdleMs === opt.value}
                    onClick={() => setIdleSkip(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="rp-mode-controls" data-testid="replay-tick-controls">
              <div className="rp-seg rp-mono" role="group" aria-label="틱 속도 선택">
                {TICK_REPLAY_RATES.map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    aria-pressed={mode.rateHz === rate}
                    onClick={() => setTickRate(rate)}
                  >
                    {`${rate}틱/s`}
                  </button>
                ))}
              </div>
              <div className="rp-seg" role="group" aria-label="틱 대상 선택">
                {TICK_FILTER_CHOICES.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={mode.filter === opt.value}
                    onClick={() => setTickFilter(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="rp-deck-tools">
          <button type="button" className="rp-flat-btn" data-testid="replay-bookmark-btn" title="현재 시각 북마크 추가 (B)" onClick={onAddBookmark}>
            <span>{bookmarks.length > 0 ? `북마크 (${bookmarks.length})` : "북마크"}</span>
            <kbd>B</kbd>
          </button>
          <button type="button" className="rp-flat-btn" data-testid="replay-loop-btn" aria-pressed={loop !== null} title="현재 시점 구간 반복 (L)" onClick={onToggleLoop}>
            <span>A-B 루프</span>
            <kbd>L</kbd>
          </button>
          <div className="rp-seg" role="group" aria-label="타임라인 확대">
            <button type="button" aria-pressed={zoom === "day"} onClick={() => onZoom("day")}>장 전체</button>
            <button type="button" aria-pressed={zoom === "10m"} onClick={() => onZoom("10m")}>±5분 정밀</button>
          </div>
        </div>
      </div>

      <div
        ref={boxRef}
        className="rp-timeline-box"
        data-testid="replay-timeline"
        aria-label="호가 복기 타임라인"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
      >
        <canvas ref={canvasRef} className="rp-canvas" />
        {hoverSec !== null && (
          <div className="rp-timeline-tooltip rp-mono" style={{ left: `${hoverX}px` }}>
            <b>{formatReplayClock(hoverSec, false)}</b>
            {hoverPrice !== null && (
              <span className={hoverRate !== null ? (hoverRate > 0 ? "rp-up" : hoverRate < 0 ? "rp-down" : "rp-muted") : ""}>
                {formatPrice(hoverPrice, false)}
                {hoverRate !== null ? ` (${formatPercent(hoverRate)})` : ""}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="rp-timeline-axis rp-mono">
        {axisLabels.map((label, idx) => <span key={idx}>{label}</span>)}
      </div>
    </section>
  );
}
