import type { ReactNode } from "react";
import { countOverlaps, type Area } from "../../layout/canvas/geometry";
import { rectsForArea } from "../../layout/canvas/arrange";
import { isSingleton, MAX_WINDOWS, WINDOW_KIND_LIST, WINDOW_KINDS, type WindowKind } from "../../layout/kinds";
import type { CanvasPlacement } from "../../layout/placement";
import { windowName, windowRefs, type WindowState } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { BookIcon, BrokersIcon, ChartIcon, FunnelIcon, IndicatorIcon, ListIcon, OrderIcon, ProgramIcon, TradesIcon } from "../icons";
import { canvasPanelId, useCanvasInteraction } from "./canvasInteraction";
import { tidyCanvas } from "./canvasCommands";
import { WINDOW_CONTENT } from "./contents";
import { addWindow, CHART_LIMIT_REASON, WINDOW_LIMIT_REASON, workspaceRoom } from "./manage";
import { WindowFrame } from "./WindowFrame";
import { WindowHeader } from "./WindowHeader";

const KIND_ICONS: Record<WindowKind, ({ size }: { size?: number }) => ReactNode> = { chart: ChartIcon, watchlist: ListIcon, screener: FunnelIcon, indicators: IndicatorIcon, trades: TradesIcon, book: BookIcon, program: ProgramIcon, brokers: BrokersIcon, order: OrderIcon };

export function CanvasWorkspace({ canvas, windows, area }: { canvas: CanvasPlacement; windows: readonly WindowState[]; area: Area }) {
  const interaction = useCanvasInteraction(canvas, windows, area);
  const active = useSelectionStore((s) => s.activeCell);
  const boxes = rectsForArea(interaction.shown, windowRefs(windows), area);
  const overlaps = countOverlaps(Object.values(boxes));
  const chartCount = windows.filter((window) => window.kind === "chart").length;
  return (
    <div className="canvas-workspace">
      <div className="canvas-stage" data-canvas-stage="" data-canvas-dragging={interaction.dragging ? "" : undefined}>
        {windows.map((window) => <WindowFrame key={window.id} id={window.id} name={windowName(windows, window)} rect={interaction.maximized === window.id ? { x: 0, y: 0, ...area } : boxes[window.id]!} layer={interaction.maximized === window.id ? windows.length + 1 : interaction.shown.order.indexOf(window.id) + 1} panelId={canvasPanelId(window.id)} overflow={WINDOW_CONTENT[window.kind].overflow} bindings={interaction.bindings(window)} maximized={interaction.maximized === window.id} active={window.kind === "chart" && active === window.id} header={<WindowHeader window={window} maximized={interaction.maximized === window.id} onMaximize={() => interaction.toggleMaximize(window)} />} />)}
        {interaction.dragging && <div className="canvas-input-shield" aria-hidden="true" />}
        {interaction.guides.x !== null && <div data-canvas-guide="x" className="canvas-guide canvas-guide-x" style={{ left: interaction.guides.x }} />}
        {interaction.guides.y !== null && <div data-canvas-guide="y" className="canvas-guide canvas-guide-y" style={{ top: interaction.guides.y }} />}
      </div>
      <div className="canvas-kind-lane">
        <nav aria-label="창 종류" className="canvas-kind-dock">
          {WINDOW_KIND_LIST.map((kind) => {
            const Icon = KIND_ICONS[kind];
            const chartFull = kind === "chart" && chartCount >= WINDOW_KINDS.chart.maxCount;
            const totalFull = windows.length >= MAX_WINDOWS && !(isSingleton(kind) && windows.some((window) => window.kind === kind));
            const full = chartFull || totalFull;
            return <button key={kind} type="button" className="canvas-kind-button" aria-label={`${WINDOW_KINDS[kind].name} 창 더하기`} title={chartFull ? CHART_LIMIT_REASON : totalFull ? WINDOW_LIMIT_REASON : WINDOW_KINDS[kind].name} disabled={full} onClick={() => addWindow(kind, workspaceRoom())}><Icon size={18} /><span>{WINDOW_KINDS[kind].name}</span></button>;
          })}
        </nav>
        <button type="button" className="tb-btn canvas-tidy" onClick={tidyCanvas}>가지런히<span aria-label="겹친 곳">{overlaps}</span></button>
      </div>
    </div>
  );
}
