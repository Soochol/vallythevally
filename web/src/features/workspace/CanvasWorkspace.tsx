import type { Area } from "../../layout/canvas/geometry";
import { rectsForArea } from "../../layout/canvas/arrange";
import type { WindowRef } from "../../layout/kinds";
import type { CanvasPlacement } from "../../layout/placement";
import { windowName, type WindowState } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { canvasPanelId, useCanvasInteraction } from "./canvasInteraction";
import { WINDOW_CONTENT } from "./contents";
import { WindowFrame } from "./WindowFrame";
import { WindowHeader } from "./WindowHeader";

export function CanvasWorkspace({ canvas, windows, refs, area }: { canvas: CanvasPlacement; windows: readonly WindowState[]; refs: readonly WindowRef[]; area: Area }) {
  const interaction = useCanvasInteraction(canvas, windows, refs, area);
  const active = useSelectionStore((s) => s.activeCell);
  const boxes = rectsForArea(interaction.shown, refs, area);
  return (
    <div className="canvas-workspace">
      <div className="canvas-stage" data-canvas-stage="" data-canvas-dragging={interaction.dragging ? "" : undefined}>
        {windows.map((window) => (
          <WindowFrame
            key={window.id}
            id={window.id}
            name={windowName(windows, window)}
            rect={interaction.maximized === window.id ? { x: 0, y: 0, ...area } : boxes[window.id]!}
            layer={interaction.maximized === window.id ? windows.length + 1 : interaction.shown.order.indexOf(window.id) + 1}
            panelId={canvasPanelId(window.id)}
            overflow={WINDOW_CONTENT[window.kind].overflow}
            bindings={interaction.bindings(window)}
            maximized={interaction.maximized === window.id}
            front={interaction.shown.order.at(-1) === window.id}
            active={window.kind === "chart" && active === window.id}
            activeResizeHandle={interaction.activeResize?.window === window.id ? interaction.activeResize.handle : null}
            header={<WindowHeader window={window} maximized={interaction.maximized === window.id} onMaximize={() => interaction.toggleMaximize(window)} />}
          />
        ))}
        {interaction.dragging && <div className="canvas-input-shield" data-cursor={interaction.dragCursor ?? undefined} aria-hidden="true" />}
        {interaction.guides.x !== null && <div data-canvas-guide="x" className="canvas-guide canvas-guide-x" style={{ left: interaction.guides.x }} />}
        {interaction.guides.y !== null && <div data-canvas-guide="y" className="canvas-guide canvas-guide-y" style={{ top: interaction.guides.y }} />}
      </div>
    </div>
  );
}
