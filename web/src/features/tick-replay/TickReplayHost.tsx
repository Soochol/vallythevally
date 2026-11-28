import { type RefObject, useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { isTypingTarget } from "../../lib/typingTarget";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { type ActiveTickReplayState, useTickReplayStore } from "../../stores/tickReplay";
import { REPLAY_REASON } from "../book-replay/replay";
import { ownsChartKeyboard } from "../overlay/topLayer";
import { pageOfPath } from "../page-rail/pages";
import { ReplayEngine } from "../replay-page/replayEngine";
import { useReplayData } from "../replay-page/useReplayData";
import { shouldStopTickReplayOnLayout } from "./scope";
import { TickReplayDock } from "./TickReplayDock";

interface Props {
  readonly workspaceRef: RefObject<HTMLElement | null>;
}

function ActiveTickReplayHost({
  active,
  workspaceRef,
}: {
  readonly active: ActiveTickReplayState;
  readonly workspaceRef: RefObject<HTMLElement | null>;
}) {
  const { runId, target } = active;
  const onWorkspace = (pageOfPath(useLocation().pathname) ?? "workspace") === "workspace";
  const data = useReplayData(target.symbol, target.date);
  const layout = useLayoutStore((s) => s.layout);
  const groupSymbols = useLayoutStore((s) => s.groupSymbols);
  const layoutSession = useLayoutStore((s) => s.session);

  const initialLayoutRef = useRef({ id: layout.id, session: layoutSession });
  const attachedRef = useRef(false);
  const controlUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const initial = initialLayoutRef.current;
    if (
      layout.id !== initial.id
      || layoutSession !== initial.session
      || shouldStopTickReplayOnLayout(layout, groupSymbols, target)
    ) {
      useTickReplayStore.getState().stop();
    }
  }, [layout, groupSymbols, layoutSession, target]);

  useEffect(() => {
    const store = useTickReplayStore.getState();
    if (data.replayFailed) {
      store.setLoad(runId, { kind: "error", message: REPLAY_REASON.failed });
      return;
    }
    if (!data.daysPending && data.days.length > 0 && !data.days.includes(target.date)) {
      store.setLoad(runId, { kind: "empty", reason: REPLAY_REASON.dayNotCollected });
      return;
    }
    if (data.replayMeta !== null && data.replayMeta.coverage !== "collected") {
      const reason =
        data.replayMeta.coverage === "symbol_not_collected"
          ? REPLAY_REASON.symbolNotCollected
          : REPLAY_REASON.dayNotCollected;
      store.setLoad(runId, { kind: "empty", reason });
      return;
    }
    if (data.activeDate !== target.date || data.session === null) return;
    if (attachedRef.current) {
      store.updateSession(runId, data.session, data.isArchive);
      return;
    }

    attachedRef.current = true;
    const engine = new ReplayEngine({
      code: target.symbol,
      session: data.session,
      meta: data.replayMeta,
      initialSec: target.start.kind === "atSec" ? target.start.sec : undefined,
      snapToFirstTick: target.start.kind === "dayStart",
    });
    const sessionEndLimitMs = Math.max(data.session.sessionStartSec * 1_000, data.session.sessionEndSec * 1_000 - 100);
    if (target.autoPlay && engine.getFrame().cursorMs < sessionEndLimitMs) {
      engine.setPlaying(true);
    }
    store.attachEngine(runId, {
      session: data.session,
      engine,
      isArchive: data.isArchive,
    });
    controlUnsubRef.current?.();
    controlUnsubRef.current = engine.subscribeControl((control) => {
      useTickReplayStore.getState().setControl(runId, control);
    });
  }, [
    runId,
    target.symbol,
    target.date,
    target.start,
    target.autoPlay,
    data.replayFailed,
    data.daysPending,
    data.days,
    data.replayMeta,
    data.activeDate,
    data.session,
    data.isArchive,
  ]);

  useEffect(() => {
    return () => {
      controlUnsubRef.current?.();
      controlUnsubRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!onWorkspace) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.isComposing
        || event.ctrlKey
        || event.metaKey
        || event.altKey
        || isTypingTarget(event.target)
        || useSelectionStore.getState().dialog !== null
        || ownsChartKeyboard(event)
      ) {
        return;
      }
      const current = useTickReplayStore.getState().state;
      if (current.kind !== "active" || current.runId !== runId) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        useTickReplayStore.getState().stop();
        return;
      }
      const engine = current.engine;
      if (!engine) return;
      if (event.key === " ") {
        event.preventDefault();
        event.stopImmediatePropagation();
        engine.togglePlay();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.shiftKey) engine.stepSec(-10);
        else engine.stepTick(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.shiftKey) engine.stepSec(10);
        else engine.stepTick(1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onWorkspace, runId]);

  const symbolName = data.symbolInfo?.name ?? target.symbol;
  return (
    <TickReplayDock
      active={active}
      symbolName={symbolName}
      workspaceRef={workspaceRef}
      onExit={() => useTickReplayStore.getState().stop()}
    />
  );
}

export function TickReplayHost({ workspaceRef }: Props) {
  const state = useTickReplayStore((s) => s.state);
  if (state.kind !== "active") return null;
  return <ActiveTickReplayHost key={state.runId} active={state} workspaceRef={workspaceRef} />;
}
