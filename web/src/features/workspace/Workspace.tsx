import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fitCanvas } from "../../layout/canvas/arrange";
import { workArea } from "../../layout/canvas/geometry";
import { placementForMode } from "../../layout/modes";
import { fitDock } from "../../layout/dock/fit";
import { drawDock, layoutDock, type DockSpace } from "../../layout/dock/geometry";
import { findJunctions } from "../../layout/dock/junction";
import type { DockPlacement } from "../../layout/placement";
import { groupOfWindow, listGroups } from "../../layout/dock/tree";
import type { WindowId } from "../../layout/kinds";
import { useLayoutStore, windowRefs } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { CanvasWorkspace } from "./CanvasWorkspace";
import { canvasPanelId } from "./canvasInteraction";
import { Divider } from "./Divider";
import { DockJunction } from "./DockJunction";
import { DockDropPreview } from "./DockDropPreview";
import { DockFloats } from "./DockFloats";
import { DockTabGhost } from "./DockTabGhost";
import { DockGroup } from "./DockGroup";
import { DockTabMenu } from "./DockTabMenu";
import { floatPanelId, useDockInteraction } from "./dockInteraction";
import { useDockMaximize } from "./useDockMaximize";
import { WindowHost } from "./WindowHost";
import { CANVAS_DOCK_HEIGHT, DOCK_GAP, useElementSize } from "./size";

const FOLD_NOTICE = "자리가 좁아 창 묶음 일부를 탭으로 접었습니다 · 창을 넓히면 돌아옵니다";

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
  const [pick, setPick] = useState<WindowId | null>(null);
  const space: DockSpace | null = useMemo(() => area && { area, gap: DOCK_GAP, windows: refs }, [area, refs]);
  const drawn = useMemo(() => (space && mode === "dock" ? drawDock(dock, space, pick) : { dock, folds: 0 }), [dock, space, mode, pick]);
  const interaction = useDockInteraction({ root, dock: drawn.dock, saved: dock, space, enabled: mode === "dock", onPick: setPick });
  const pending = draft ?? interaction.shown;
  const shown = useMemo(() => (space && pending !== drawn.dock ? drawDock(pending, space, pick).dock : pending), [pending, drawn.dock, space, pick]);
  const maximize = useDockMaximize({ dock: drawn.dock, enabled: mode === "dock", dragging: interaction.dragging });
  const activeCell = useSelectionStore((s) => s.activeCell);
  const shownCharts = useMemo(() => [...listGroups(drawn.dock.root).filter((group) => maximize.maximized === null || group.id === maximize.maximized).map((group) => group.active), ...drawn.dock.floats.map((float) => float.window)].filter((id) => windows.some((w) => w.id === id && w.kind === "chart")), [drawn.dock, windows, maximize.maximized]);
  const folded = drawn.folds > 0;

  useEffect(() => {
    if (folded) useSelectionStore.getState().showToast(FOLD_NOTICE);
  }, [folded]);

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
  const maximizedGroup = boxes?.groups.find(({ group }) => group.id === maximize.maximized);
  const preview = interaction.preview;
  return (
    <main ref={root} aria-label="작업 영역" className="workspace" data-dock-dragging={interaction.dragging ? "" : undefined} onLostPointerCapture={interaction.lostCapture}>
      {mode === "canvas" && canvas && canvasArea ? <CanvasWorkspace canvas={canvas} windows={windows} area={canvasArea} /> : null}
      {mode === "dock" && boxes?.groups.map(({ group, rect }, index) => (maximizedGroup && group.id !== maximizedGroup.group.id ? null : <DockGroup key={group.id} group={group} rect={maximizedGroup && space ? { x: 0, y: 0, w: space.area.w, h: space.area.h } : rect} number={index + 1} interaction={interaction} maximized={maximizedGroup !== undefined} onToggleMaximize={() => maximize.toggle(group.id)} />))}
      {mode === "dock" && space && !maximizedGroup && boxes?.gutters.map((box) => <Divider key={box.path.join("-") || "root"} box={box} dock={drawn.dock} space={space} onDraft={setDraft} />)}
      {mode === "dock" && space && !maximizedGroup && boxes && findJunctions(boxes).map((junction) => <DockJunction key={`${junction.rowPath.join("-")}|${junction.columnPath.join("-")}`} junction={junction} layout={boxes} dock={drawn.dock} space={space} onDraft={setDraft} />)}
      {mode === "dock" && area && <DockFloats dock={shown} windows={windows} area={area} interaction={interaction} />}
      <div ref={parking} hidden inert />
      {windows.map((window) => {
        const group = groupOfWindow(shown.root, window.id);
        const panel = mode === "canvas" ? canvasPanelId(window.id) : shown.floats.some((float) => float.window === window.id) ? floatPanelId(window.id) : group?.active === window.id && (!maximizedGroup || group.id === maximizedGroup.group.id) ? `window-panel-${group.id}` : null;
        return <WindowHost key={window.id} window={window} panel={panel} parking={parking} />;
      })}
      {mode === "dock" && interaction.dragging && <div className="dock-input-shield" aria-hidden="true" />}
      {mode === "dock" && preview && preview.kind !== "unchanged" && <DockDropPreview preview={preview} />}
      {mode === "dock" && interaction.grab && <DockTabGhost grab={interaction.grab} />}
      <div role="status" className="sr-only">{mode === "dock" && preview && preview.kind !== "unchanged" ? preview.label : ""}</div>
      {mode === "dock" && interaction.menu && space && <DockTabMenu key={interaction.menu.window} interaction={interaction} dock={drawn.dock} space={space} root={root} maximized={maximize.maximized} onToggleMaximize={maximize.toggle} />}
    </main>
  );
}
