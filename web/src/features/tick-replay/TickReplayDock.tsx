import { type PointerEvent, type RefObject, useEffect, useRef, useState } from "react";
import type { ActiveTickReplayState } from "../../stores/tickReplay";
import { REPLAY_ARCHIVE_TITLE } from "../book-replay/ReplayStrip";
import { GripIcon, PauseIcon, PlayIcon } from "../icons";
import {
  type PlaybackMode,
  type ReplayEngineFrame,
  TICK_REPLAY_RATES,
  type TickReplayRate,
  WORKSPACE_TIME_SPEEDS,
  type WorkspaceTimeSpeed,
} from "../replay-page/replayEngine";
import {
  formatReplayClock,
  formatReplayHM,
  formatShortDay,
  REGULAR_END_MIN,
  REGULAR_START_MIN,
} from "../replay-page/replayModel";
import "./tickReplayDock.css";

interface Props {
  readonly active: ActiveTickReplayState;
  readonly symbolName: string;
  readonly workspaceRef: RefObject<HTMLElement | null>;
  readonly onExit: () => void;
}

interface DockPos {
  readonly x: number;
  readonly y: number;
}

const EDGE_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function setText(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

export function TickReplayDock({ active, symbolName, workspaceRef, onExit }: Props) {
  const { target, load, session, engine, isArchive, control } = active;
  const dockRef = useRef<HTMLElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const sessionPillRef = useRef<HTMLSpanElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const scrubberRef = useRef<HTMLDivElement>(null);

  const [pos, setPos] = useState<DockPos | null>(null);
  const dragRef = useRef<{
    readonly originX: number;
    readonly originY: number;
    readonly startX: number;
    readonly startY: number;
    readonly maxX: number;
    readonly maxY: number;
  } | null>(null);
  const scrubbingRef = useRef(false);

  const startSec = session?.sessionStartSec ?? REGULAR_START_MIN * 60;
  const endSec = session?.sessionEndSec ?? REGULAR_END_MIN * 60;
  const spanSec = Math.max(1, endSec - startSec);

  useEffect(() => {
    const paint = (frame: ReplayEngineFrame) => {
      const cursorSec = frame.cursorMs / 1_000;
      setText(clockRef.current, formatReplayClock(cursorSec, true));
      if (sessionPillRef.current) {
        const kind = frame.inGap ? "gap" : frame.singlePrice ? "vi" : "open";
        const label = frame.inGap ? "수집 끊김" : frame.singlePrice ? "단일가" : "정규장";
        sessionPillRef.current.dataset.kind = kind;
        setText(sessionPillRef.current, label);
      }
      const ratio = clamp((cursorSec - startSec) / spanSec, 0, 1);
      const pct = `${(ratio * 100).toFixed(3)}%`;
      if (fillRef.current) fillRef.current.style.width = pct;
      if (thumbRef.current) thumbRef.current.style.left = pct;
      if (scrubberRef.current) scrubberRef.current.setAttribute("aria-valuenow", String(Math.round(cursorSec)));
    };

    if (!engine) {
      setText(clockRef.current, formatReplayClock(control.activeSecond, true));
      const ratio = clamp((control.activeSecond - startSec) / spanSec, 0, 1);
      const pct = `${(ratio * 100).toFixed(3)}%`;
      if (fillRef.current) fillRef.current.style.width = pct;
      if (thumbRef.current) thumbRef.current.style.left = pct;
      return;
    }

    return engine.subscribeFrame(paint);
  }, [engine, startSec, spanSec]);

  const onDragStart = (event: PointerEvent<HTMLButtonElement>) => {
    const dock = dockRef.current;
    const workspace = workspaceRef.current;
    if (!dock || !workspace) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const dockRect = dock.getBoundingClientRect();
    const wsRect = workspace.getBoundingClientRect();
    dragRef.current = {
      originX: event.clientX,
      originY: event.clientY,
      startX: dockRect.left - wsRect.left,
      startY: dockRect.top - wsRect.top,
      maxX: Math.max(EDGE_MARGIN, wsRect.width - dockRect.width - EDGE_MARGIN),
      maxY: Math.max(EDGE_MARGIN, wsRect.height - dockRect.height - EDGE_MARGIN),
    };
  };

  const onDragMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPos({
      x: clamp(drag.startX + event.clientX - drag.originX, EDGE_MARGIN, drag.maxX),
      y: clamp(drag.startY + event.clientY - drag.originY, EDGE_MARGIN, drag.maxY),
    });
  };

  const onDragEnd = () => {
    dragRef.current = null;
  };

  const scrubFromClientX = (clientX: number, targetEl: HTMLDivElement) => {
    if (!engine) return;
    const rect = targetEl.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    engine.seekSec(startSec + ratio * spanSec);
  };

  const onScrubDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!engine) return;
    event.preventDefault();
    scrubbingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubFromClientX(event.clientX, event.currentTarget);
  };

  const onScrubMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    scrubFromClientX(event.clientX, event.currentTarget);
  };

  const onScrubUp = () => {
    scrubbingRef.current = false;
  };

  const setMode = (mode: PlaybackMode) => {
    engine?.setMode(mode);
  };

  const setTimeSpeed = (speed: WorkspaceTimeSpeed) => {
    const skipIdleMs = control.mode.kind === "time" ? control.mode.skipIdleMs : null;
    setMode({ kind: "time", speed, skipIdleMs });
  };

  const setTickRate = (rateHz: TickReplayRate) => {
    const filter = control.mode.kind === "tick" ? control.mode.filter : "all";
    setMode({ kind: "tick", rateHz, filter });
  };

  const switchToTime = () => {
    if (control.mode.kind === "time") return;
    setMode({ kind: "time", speed: 1, skipIdleMs: null });
  };

  const switchToTick = () => {
    if (control.mode.kind === "tick") return;
    setMode({ kind: "tick", rateHz: 5, filter: "all" });
  };

  const posStyle = pos === null
    ? undefined
    : { left: `${pos.x}px`, top: `${pos.y}px`, bottom: "auto", transform: "none" };

  return (
    <section
      ref={dockRef}
      className="trd-dock"
      role="region"
      aria-label="틱 복기 재생 리모콘"
      data-testid="tick-replay-dock"
      data-playing={control.playing ? "true" : "false"}
      style={posStyle}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="trd-row">
        <button
          type="button"
          className="trd-grip"
          data-testid="tick-replay-drag-handle"
          aria-label="리모콘 옮기기"
          title="끌어서 리모콘 옮기기"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <GripIcon size={14} />
        </button>

        <div className="trd-meta">
          <span className="trd-symbol" data-testid="tick-replay-symbol">{symbolName}</span>
          <span className="trd-date" data-testid="tick-replay-date">{formatShortDay(target.date)}</span>
          <span ref={clockRef} className="trd-clock" data-testid="tick-replay-clock">
            {formatReplayClock(control.activeSecond, true)}
          </span>
          <span ref={sessionPillRef} className="trd-pill" data-testid="tick-replay-session" data-kind="open">
            정규장
          </span>
          {isArchive && (
            <span className="trd-badge-archive" data-testid="tick-replay-archive-badge" title={REPLAY_ARCHIVE_TITLE}>
              KRX 단독
            </span>
          )}
          {(load.kind === "loading" || control.buffering) && (
            <span className="trd-status-note" data-testid="tick-replay-buffering">불러오는 중</span>
          )}
          {load.kind === "empty" && (
            <span className="trd-status-note" data-testid="tick-replay-error">{load.reason}</span>
          )}
          {load.kind === "error" && (
            <span className="trd-status-note" data-tone="error" data-testid="tick-replay-error">{load.message}</span>
          )}
        </div>

        <button
          type="button"
          className="trd-btn trd-exit"
          data-testid="tick-replay-exit"
          onClick={onExit}
        >
          실시간 복귀
        </button>
      </div>

      <div className="trd-row">
        <div className="trd-controls">
          <div className="trd-transport" role="group" aria-label="틱 복기 재생 제어">
            <button
              type="button"
              className="trd-btn trd-mono"
              data-testid="tick-replay-step-prev"
              aria-label="이전 틱"
              disabled={engine === null}
              onClick={() => engine?.stepTick(-1)}
            >
              -1틱
            </button>
            <button
              type="button"
              className="trd-btn trd-play"
              data-testid="tick-replay-play"
              data-playing={control.playing ? "true" : "false"}
              disabled={engine === null}
              onClick={() => engine?.togglePlay()}
            >
              {control.playing ? <PauseIcon size={12} /> : <PlayIcon size={10} />}
              <span>{control.playing ? "멈춤" : "재생"}</span>
            </button>
            <button
              type="button"
              className="trd-btn trd-mono"
              data-testid="tick-replay-step-next"
              aria-label="다음 틱"
              disabled={engine === null}
              onClick={() => engine?.stepTick(1)}
            >
              +1틱
            </button>
          </div>

          <div className="trd-seg" role="group" aria-label="재생 방식" data-testid="tick-replay-mode-switch">
            <button
              type="button"
              className="trd-seg-btn"
              aria-pressed={control.mode.kind === "time"}
              disabled={engine === null}
              onClick={switchToTime}
            >
              시간
            </button>
            <button
              type="button"
              className="trd-seg-btn"
              aria-pressed={control.mode.kind === "tick"}
              disabled={engine === null}
              onClick={switchToTick}
            >
              틱
            </button>
          </div>

          {control.mode.kind === "time" ? (
            <div className="trd-seg trd-mono" role="group" aria-label="배속 선택" data-testid="tick-replay-time-speeds">
              {WORKSPACE_TIME_SPEEDS.map((sp) => (
                <button
                  key={sp}
                  type="button"
                  className="trd-seg-btn"
                  aria-pressed={control.mode.kind === "time" && control.mode.speed === sp}
                  disabled={engine === null}
                  onClick={() => setTimeSpeed(sp)}
                >
                  {`${sp}x`}
                </button>
              ))}
            </div>
          ) : (
            <div className="trd-seg trd-mono" role="group" aria-label="틱 속도 선택" data-testid="tick-replay-tick-rates">
              {TICK_REPLAY_RATES.map((rate) => (
                <button
                  key={rate}
                  type="button"
                  className="trd-seg-btn"
                  aria-pressed={control.mode.kind === "tick" && control.mode.rateHz === rate}
                  disabled={engine === null}
                  onClick={() => setTickRate(rate)}
                >
                  {`${rate}틱/s`}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="trd-scrub-row">
        <span className="trd-scrub-edge">{formatReplayHM(startSec)}</span>
        <div
          ref={scrubberRef}
          className="trd-scrubber"
          role="slider"
          tabIndex={0}
          aria-label="재생 시각 스크러버"
          aria-valuemin={startSec}
          aria-valuemax={endSec}
          aria-valuenow={control.activeSecond}
          aria-disabled={engine === null ? "true" : undefined}
          data-testid="tick-replay-scrubber"
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubUp}
          onPointerCancel={onScrubUp}
        >
          <div className="trd-scrubber-rail">
            <div ref={fillRef} className="trd-scrubber-fill" />
          </div>
          <div ref={thumbRef} className="trd-scrubber-thumb" />
        </div>
        <span className="trd-scrub-edge">{formatReplayHM(endSec)}</span>
      </div>
    </section>
  );
}
