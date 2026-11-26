import { type PointerEvent, useEffect, useRef, useState } from "react";
import { formatPercent, formatPrice } from "../../lib/format";
import { type CanvasPalette } from "./canvasTheme";
import {
  formatReplayClock,
  frameIndexAt,
  REPLAY_SPEEDS,
  type ReplayFrame,
  type ReplaySession,
} from "./replayModel";

export type TimelineZoom = "day" | "10m";

export interface LoopRange {
  readonly a: number;
  readonly b: number;
}

interface Props {
  readonly session: ReplaySession;
  readonly frame: ReplayFrame | null;
  readonly cursorSec: number;
  readonly playing: boolean;
  readonly speed: number;
  readonly bookmarks: readonly number[];
  readonly loop: LoopRange | null;
  readonly zoom: TimelineZoom;
  readonly palette: CanvasPalette;
  readonly onTogglePlay: () => void;
  readonly onStepTick: (dir: -1 | 1) => void;
  readonly onStepSec: (deltaSec: number) => void;
  readonly onSpeed: (speed: number) => void;
  readonly onAddBookmark: () => void;
  readonly onToggleLoop: () => void;
  readonly onZoom: (zoom: TimelineZoom) => void;
  readonly onScrub: (sec: number) => void;
}

function timelineBounds(session: ReplaySession, cursorSec: number, zoom: TimelineZoom) {
  if (zoom === "day") return { start: session.sessionStartSec, end: session.sessionEndSec };
  const half = 300;
  let start = Math.max(session.sessionStartSec, cursorSec - half);
  const end = Math.min(session.sessionEndSec, start + half * 2);
  start = Math.max(session.sessionStartSec, end - half * 2);
  return { start, end };
}

export function ReplayDeck({
  session,
  frame,
  cursorSec,
  playing,
  speed,
  bookmarks,
  loop,
  zoom,
  palette,
  onTogglePlay,
  onStepTick,
  onStepSec,
  onSpeed,
  onAddBookmark,
  onToggleLoop,
  onZoom,
  onScrub,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);
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

  const { start, end } = timelineBounds(session, cursorSec, zoom);
  const span = Math.max(1, end - start);

  useEffect(() => {
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

    const xOfSec = (sec: number) => ((sec - start) / span) * w;

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

    const px = xOfSec(cursorSec);
    ctx.fillStyle = palette.seriesFill;
    ctx.fillRect(0, 0, Math.max(0, px), h);

    if (hoverSec !== null && hoverSec >= start && hoverSec <= end) {
      const hx = xOfSec(hoverSec);
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
  }, [session, cursorSec, bookmarks, loop, start, end, span, hoverSec, palette, resizeTick]);

  const secFromEvent = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    return start + ratio * span;
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

  const hoverFrame = hoverSec !== null ? session.frames[frameIndexAt(session.frames, hoverSec)] : null;
  const hoverRate = hoverFrame?.price !== null && hoverFrame?.price !== undefined && session.previousClose
    ? ((hoverFrame.price - session.previousClose) / session.previousClose) * 100
    : null;

  const sessionKind = frame?.inGap ? "gap" : frame?.singlePrice ? "vi" : "open";
  const sessionLabel = frame?.inGap ? "수집 끊김" : frame?.singlePrice ? "단일가" : "정규장";

  const axisLabels = Array.from({ length: 8 }, (_, i) => formatReplayClock(start + (span * i) / 7, false));

  return (
    <footer className="rp-deck" data-testid="replay-deck">
      <div className="rp-deck-controls">
        <div className="rp-clock-box">
          <span className="rp-clock-val rp-mono" data-testid="replay-clock">{formatReplayClock(cursorSec, true)}</span>
          <span className="rp-session-pill" data-kind={sessionKind}>{sessionLabel}</span>
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
            {playing ? "멈춤" : "재생"}
          </button>
          <button type="button" className="rp-tbtn" title="다음 틱 (.)" onClick={() => onStepTick(1)}>+1틱</button>
          <button type="button" className="rp-tbtn" title="+1초 (→)" onClick={() => onStepSec(1)}>+1s</button>
          <button type="button" className="rp-tbtn" title="+1분 (PageUp)" onClick={() => onStepSec(60)}>+1m</button>
        </div>

        <div className="rp-seg rp-mono" role="group" aria-label="배속 선택">
          {REPLAY_SPEEDS.map((sp) => (
            <button
              key={sp}
              type="button"
              aria-pressed={speed === sp}
              onClick={() => onSpeed(sp)}
            >
              {`${sp}x`}
            </button>
          ))}
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
            {hoverFrame?.price !== null && hoverFrame?.price !== undefined && (
              <span className={hoverRate !== null ? (hoverRate >= 0 ? "rp-up" : "rp-down") : ""}>
                {formatPrice(hoverFrame.price, false)}
                {hoverRate !== null ? ` (${formatPercent(hoverRate)})` : ""}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="rp-timeline-axis rp-mono">
        {axisLabels.map((label, idx) => <span key={idx}>{label}</span>)}
      </div>
    </footer>
  );
}
