import { useEffect, useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { WindowId } from "../../layout/kinds";
import { chartWindows, type EditableLayout, type GroupSymbols, useLayoutStore } from "../../stores/layout";
import { type ActiveTickReplayState, type TickReplayTarget, useTickReplayStore } from "../../stores/tickReplay";
import type { ReplayEngine, ReplayEngineFrame } from "../replay-page/replayEngine";

export function matchesTickReplayWindow(
  layout: EditableLayout,
  windowId: WindowId | undefined,
  code: SymbolCode,
  target: TickReplayTarget,
): boolean {
  if (code !== target.symbol) return false;
  if (target.link === null) return true;
  if (windowId === undefined) return false;
  const win = layout.windows.find((w) => w.id === windowId);
  return win !== undefined && (win.id === target.cellId || win.link === target.link);
}

export function shouldStopTickReplayOnLayout(
  layout: EditableLayout,
  groupSymbols: GroupSymbols,
  target: TickReplayTarget,
): boolean {
  const charts = chartWindows(layout);
  const sourceChart = charts.find((w) => w.id === target.cellId);
  if (!sourceChart || sourceChart.symbol !== target.symbol) return true;
  if (target.link !== null) {
    const groupSymbol = groupSymbols[target.link];
    if (groupSymbol !== undefined && groupSymbol !== target.symbol) return true;
    for (const chart of charts) {
      if (chart.link === target.link && chart.symbol !== target.symbol) return true;
    }
  }
  return false;
}

export function useTickReplayMatch(
  windowId: WindowId | undefined,
  code: SymbolCode | undefined,
): ActiveTickReplayState | null {
  const state = useTickReplayStore((s) => s.state);
  const matched = useLayoutStore((s) =>
    state.kind === "active" && code !== undefined && matchesTickReplayWindow(s.layout, windowId, code, state.target),
  );
  return state.kind === "active" && matched ? state : null;
}

export function useTickReplayFrame(engine: ReplayEngine | null): ReplayEngineFrame | null {
  const [frame, setFrame] = useState<ReplayEngineFrame | null>(() => (engine ? engine.getFrame() : null));

  useEffect(() => {
    if (!engine) {
      setFrame(null);
      return;
    }
    return engine.subscribeFrame((next) => {
      setFrame(next);
    });
  }, [engine]);

  return engine ? frame ?? engine.getFrame() : null;
}

export function useTickReplayPrice(engine: ReplayEngine | null): number | null {
  const [price, setPrice] = useState<number | null>(() => (engine ? engine.getFrame().price : null));

  useEffect(() => {
    if (!engine) {
      setPrice(null);
      return;
    }
    return engine.subscribeFrame((next) => {
      setPrice((prev) => (prev === next.price ? prev : next.price));
    });
  }, [engine]);

  return engine ? price : null;
}
