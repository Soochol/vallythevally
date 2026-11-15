import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fitCanvas } from "../../layout/canvas/arrange";
import { workArea } from "../../layout/canvas/geometry";
import { placementForMode } from "../../layout/modes";
import { fitDock } from "../../layout/dock/fit";
import { layoutDock, type DockSpace } from "../../layout/dock/geometry";
import type { DockPlacement } from "../../layout/placement";
import { groupOfWindow, listGroups } from "../../layout/dock/tree";
import { useLayoutStore, windowRefs } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { CanvasWorkspace } from "./CanvasWorkspace";
import { canvasPanelId } from "./canvasInteraction";
import { Divider } from "./Divider";
import { DockFloats } from "./DockFloats";
import { DockGroup } from "./DockGroup";
import { DockTabMenu } from "./DockTabMenu";
import { floatPanelId, useDockInteraction } from "./dockInteraction";
import { WindowHost } from "./WindowHost";
import { CANVAS_DOCK_HEIGHT, DOCK_GAP, useElementSize } from "./size";

export function Workspace() {
  const root = useRef<HTMLElement>(null);
  const parking = useRef<HTMLDivElement>(null);
  const area = useElementSize(root);
  const mode = useUiStore((s) => s.prefs.layoutMode);
  const placement = useLayoutStore((s) => s.layout.placement);
  const canvasArea = useMemo(() => area && workArea(area.w, area.h - CANVAS_DOCK_HEIGHT), [area]);
  const windows = useLayoutStore((s) => s.layout.windows);
  const saved = useLayoutStore((s) => s.layout.placement.dock);
  const refs = useMemo(() => windowRefs(windows), [windows]);
  const dock = useMemo(() => fitDock(saved, refs), [saved, refs]);
  const canvas = useMemo(() => canvasArea && fitCanvas(placement.canvas, refs, canvasArea), [placement.canvas, refs, canvasArea]);
  const [draft, setDraft] = useState<DockPlacement | null>(null);
  const space: DockSpace | null = area && { area, gap: DOCK_GAP, windows: refs };
  const interaction = useDockInteraction({ root, dock, space, enabled: mode === "dock" });
  const shown = draft ?? interaction.shown;
  const activeCell = useSelectionStore((s) => s.activeCell);
  const shownCharts = useMemo(() => [...listGroups(dock.root).map((group) => group.active), ...dock.floats.map((float) => float.window)].filter((id) => windows.some((w) => w.id === id && w.kind === "chart")), [dock, windows]);

  useEffect(() => {
    if (mode === "dock" && saved && dock !== saved) useLayoutStore.getState().settleDock(dock);
  }, [dock, saved, mode]);

  useEffect(() => {
    if (mode !== "dock") return;
    const [first] = shownCharts;
    if (first && !shownCharts.includes(activeCell)) useSelectionStore.getState().setActiveCell(first);
  }, [shownCharts, activeCell, mode]);

  useLayoutEffect(() => {
    const state = useLayoutStore.getState();
    state.setCanvasArea(mode === "canvas" ? canvasArea : null);
    if ((mode === "canvas" || (placement.dock === null && placement.canvas !== null)) && canvasArea && area) state.settlePlacement(placementForMode(placement, refs, mode, { dock: { area, gap: DOCK_GAP }, canvas: canvasArea }));
  }, [mode, canvasArea, area, placement, refs]);
  useLayoutEffect(() => () => useLayoutStore.getState().setCanvasArea(null), []);

  const boxes = space && layoutDock(shown.root, space.area, space.gap);
  const preview = interaction.preview;
  return (
    <main ref={root} aria-label="작업 영역" className="workspace" data-dock-dragging={interaction.dragging ? "" : undefined} onLostPointerCapture={interaction.lostCapture}>
      {mode === "canvas" && canvas && canvasArea ? <CanvasWorkspace canvas={canvas} windows={windows} area={canvasArea} /> : null}
      {mode === "dock" && boxes?.groups.map(({ group, rect }, index) => <DockGroup key={group.id} group={group} rect={rect} number={index + 1} interaction={interaction} />)}
      {mode === "dock" && space && boxes?.gutters.map((box) => <Divider key={box.path.join("-") || "root"} box={box} dock={dock} space={space} onDraft={setDraft} />)}
      {mode === "dock" && area && <DockFloats dock={shown} windows={windows} area={area} interaction={interaction} />}
      <div ref={parking} hidden inert />
      {windows.map((window) => {
        const group = groupOfWindow(shown.root, window.id);
        const panel = mode === "canvas" ? canvasPanelId(window.id) : shown.floats.some((float) => float.window === window.id) ? floatPanelId(window.id) : group?.active === window.id ? `window-panel-${group.id}` : null;
        return <WindowHost key={window.id} window={window} panel={panel} parking={parking} />;
      })}
      {mode === "dock" && interaction.dragging && <div className="dock-input-shield" aria-hidden="true" />}
      {mode === "dock" && preview && preview.kind !== "unchanged" && <div data-dock-preview={preview.kind} className="dock-drop-preview" style={{ left: preview.rect.x, top: preview.rect.y, width: preview.rect.w, height: preview.rect.h }}><span>{preview.label}</span></div>}
      <div role="status" className="sr-only">{mode === "dock" && preview && preview.kind !== "unchanged" ? preview.label : ""}</div>
      {mode === "dock" && interaction.menu && space && <DockTabMenu key={interaction.menu.window} interaction={interaction} dock={dock} space={space} root={root} />}
    </main>
  );
}
