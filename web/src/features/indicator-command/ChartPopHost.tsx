import { type KeyboardEvent, useRef } from "react";
import { isTypingTarget } from "../../lib/typingTarget";
import { chartWindows, useLayoutStore } from "../../stores/layout";
import { useSelectionStore, type ChartPop } from "../../stores/selection";
import { ChartSettingsSections } from "../chart-settings/ChartSettingsDialog";
import { IndicatorPopover } from "../indicator-dialog/IndicatorPopover";
import { Popover } from "../overlay/Popover";
import { IndicatorAddPanel } from "./IndicatorAddPanel";
import { CHART_POP_TRIGGERS } from "./open";
import { isUndoKey, undoChartSettings } from "./settingsHistory";

const isTrigger = (target: Node): boolean => target instanceof Element && target.closest(CHART_POP_TRIGGERS) !== null;

function undoKeys(event: KeyboardEvent): void {
  const command = isUndoKey(event.nativeEvent);
  if (!command || isTypingTarget(event.target)) return;
  event.preventDefault();
  undoChartSettings({ kind: "open" }, command === "redo");
}

export function ChartPopHost() {
  const pop = useSelectionStore((s) => s.chartPop);
  const close = useSelectionStore((s) => s.closeChartPop);
  const exists = useLayoutStore((s) => {
    if (!pop) return false;
    const cell = chartWindows(s.layout).find((item) => item.id === pop.cellId);
    return cell !== undefined && (pop.kind !== "indicator" || cell.chartSettings.indicators.some((item) => item.id === pop.indicatorId));
  });
  if (!pop || !exists || !pop.anchor.isConnected) return null;
  if (pop.kind === "indicator") return <IndicatorBubble key={`${pop.cellId}:${pop.indicatorId}`} pop={pop} onClose={close} />;
  if (pop.kind === "add") return <AddPopover key={`add:${pop.cellId}`} pop={pop} onClose={close} />;
  return <SettingsPopover key={`settings:${pop.cellId}`} pop={pop} onClose={close} />;
}

function IndicatorBubble({ pop, onClose }: { pop: Extract<ChartPop, { kind: "indicator" }>; onClose(): void }) {
  const initial = useRef(chartWindows(useLayoutStore.getState().layout).find((cell) => cell.id === pop.cellId)?.chartSettings.indicators.find((item) => item.id === pop.indicatorId) ?? null);
  if (!initial.current) return null;
  return <IndicatorPopover cellId={pop.cellId} initial={initial.current} anchor={pop.anchor} field={pop.field} onClose={onClose} />;
}

function AddPopover({ pop, onClose }: { pop: Extract<ChartPop, { kind: "add" }>; onClose(): void }) {
  const anchor = useRef(pop.anchor);
  return <Popover anchor={anchor} isInside={isTrigger} solid follow onClose={onClose} role="dialog" aria-label="지표 더하기" data-chart-control="" className="ia-popover" onKeyDown={undoKeys}>
    <IndicatorAddPanel cellId={pop.cellId} section={pop.section} autoFocus onSection={(section) => useSelectionStore.getState().openChartPop({ ...pop, section })} />
  </Popover>;
}

function SettingsPopover({ pop, onClose }: { pop: Extract<ChartPop, { kind: "settings" }>; onClose(): void }) {
  const anchor = useRef(pop.anchor);
  return <Popover anchor={anchor} isInside={isTrigger} solid follow onClose={onClose} role="dialog" aria-label="차트 설정" data-chart-control="" className="cs-popover" onKeyDown={undoKeys}>
    <ChartSettingsSections cellId={pop.cellId} onClose={onClose} />
  </Popover>;
}
