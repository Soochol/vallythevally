import { workArea } from "../../layout/canvas/geometry";
import { floatRects } from "../../layout/dock/floats";
import type { Size } from "../../layout/dock/geometry";
import { WINDOW_KINDS } from "../../layout/kinds";
import type { DockPlacement } from "../../layout/placement";
import { useLayoutStore, windowRefs, type WindowState } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { WINDOW_CONTENT } from "./contents";
import { floatPanelId, type DockInteraction } from "./dockInteraction";
import { WindowFrame } from "./WindowFrame";
import { WindowHeader } from "./WindowHeader";

export function DockFloats({ dock, windows, area, interaction }: { dock: DockPlacement; windows: readonly WindowState[]; area: Size; interaction: DockInteraction }) {
  const active = useSelectionStore((s) => s.activeCell);
  const room = workArea(area.w, area.h);
  if (!room) return null;
  const boxes = floatRects(dock, windowRefs(windows), room);
  return <div className="dock-floats">
    {dock.floats.map((float, index) => {
      const window = windows.find((window) => window.id === float.window);
      return window && <WindowFrame key={window.id} surface="dock-float" id={window.id} name={WINDOW_KINDS[window.kind].name} rect={boxes[window.id]!} layer={index + 1} panelId={floatPanelId(window.id)} overflow={WINDOW_CONTENT[window.kind].overflow} bindings={interaction.floatBindings(window)} maximized={false} active={window.kind === "chart" && active === window.id} header={<WindowHeader window={window} action={{ kind: "attach", run: () => { useLayoutStore.getState().attachFloat(window.id); } }} />} />;
    })}
    {interaction.guides.x !== null && <div data-dock-guide="x" className="canvas-guide canvas-guide-x" style={{ left: interaction.guides.x }} />}
    {interaction.guides.y !== null && <div data-dock-guide="y" className="canvas-guide canvas-guide-y" style={{ top: interaction.guides.y }} />}
  </div>;
}
