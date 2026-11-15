import { useEffect, useMemo, useRef, useState } from "react";
import { fitDock } from "../../layout/dock/fit";
import { layoutDock, type DockSpace } from "../../layout/dock/geometry";
import type { DockPlacement } from "../../layout/placement";
import { groupOfWindow, listGroups } from "../../layout/dock/tree";
import { useLayoutStore, windowRefs } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { Divider } from "./Divider";
import { DockGroup } from "./DockGroup";
import { DockTabMenu } from "./DockTabMenu";
import { useDockInteraction } from "./dockInteraction";
import { WindowHost } from "./WindowHost";
import { DOCK_GAP, useElementSize } from "./size";

export function Workspace() {
  const root = useRef<HTMLElement>(null);
  const parking = useRef<HTMLDivElement>(null);
  const area = useElementSize(root);
  const windows = useLayoutStore((s) => s.layout.windows);
  const saved = useLayoutStore((s) => s.layout.placement.dock);
  const refs = useMemo(() => windowRefs(windows), [windows]);
  const dock = useMemo(() => fitDock(saved, refs), [saved, refs]);
  const [draft, setDraft] = useState<DockPlacement | null>(null);
  const shown = draft ?? dock;
  const activeCell = useSelectionStore((s) => s.activeCell);
  const shownCharts = useMemo(() => listGroups(dock.root).map((group) => group.active).filter((id) => windows.some((w) => w.id === id && w.kind === "chart")), [dock, windows]);

  useEffect(() => {
    if (saved && dock !== saved) useLayoutStore.getState().settleDock(dock);
  }, [dock, saved]);

  useEffect(() => {
    const [first] = shownCharts;
    if (first && !shownCharts.includes(activeCell)) useSelectionStore.getState().setActiveCell(first);
  }, [shownCharts, activeCell]);

  const space: DockSpace | null = area && { area, gap: DOCK_GAP, windows: refs };
  const boxes = space && layoutDock(shown.root, space.area, space.gap);
  const interaction = useDockInteraction({ root, dock, space });
  const preview = interaction.preview;
  return (
    <main ref={root} aria-label="작업 영역" className="workspace" data-dock-dragging={interaction.dragging ? "" : undefined} onLostPointerCapture={interaction.lostCapture}>
      {boxes?.groups.map(({ group, rect }, index) => <DockGroup key={group.id} group={group} rect={rect} number={index + 1} interaction={interaction} />)}
      {space && boxes?.gutters.map((box) => <Divider key={box.path.join("-") || "root"} box={box} dock={dock} space={space} onDraft={setDraft} />)}
      <div ref={parking} hidden inert />
      {windows.map((window) => <WindowHost key={window.id} window={window} group={groupOfWindow(shown.root, window.id)} parking={parking} />)}
      {interaction.dragging && <div className="dock-input-shield" aria-hidden="true" />}
      {preview && preview.kind !== "unchanged" && <div data-dock-preview={preview.kind} className="dock-drop-preview" style={{ left: preview.rect.x, top: preview.rect.y, width: preview.rect.w, height: preview.rect.h }}><span>{preview.label}</span></div>}
      <div role="status" className="sr-only">{preview && preview.kind !== "unchanged" ? preview.label : ""}</div>
      {interaction.menu && space && <DockTabMenu key={interaction.menu.window} interaction={interaction} dock={dock} space={space} root={root} />}
    </main>
  );
}
