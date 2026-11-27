import { useMemo, useRef, useState } from "react";
import { fitCanvas, rectsForArea } from "../../layout/canvas/arrange";
import { countOverlaps } from "../../layout/canvas/geometry";
import { useLadderRateShown, useUiStore } from "../../stores/ui";
import { useLayoutStore, windowRefs } from "../../stores/layout";
import { equalizeDockSizes, setLayoutMode } from "../workspace/canvasCommands";
import { DockIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";
import { Badge } from "../ui/Badge";
import { layoutCommands } from "./controller";

export function ArrangeMenu() {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const mode = useUiStore((s) => s.prefs.layoutMode);
  const rateShown = useLadderRateShown();
  const hasDock = useLayoutStore((s) => !!s.layout.placement.dock);
  const canvasPlacement = useLayoutStore((s) => s.layout.placement.canvas);
  const canvasArea = useLayoutStore((s) => s.canvasArea);
  const windows = useLayoutStore((s) => s.layout.windows);
  const canUndo = useLayoutStore((s) => s.steps.length > 0);
  const canRedo = useLayoutStore((s) => s.redos.length > 0);
  const overlaps = useMemo(() => {
    if (mode !== "canvas" || !canvasArea) return 0;
    const refs = windowRefs(windows, !rateShown);
    const fitted = fitCanvas(canvasPlacement, refs, canvasArea);
    return countOverlaps(Object.values(rectsForArea(fitted, refs, canvasArea)));
  }, [mode, canvasArea, canvasPlacement, windows, rateShown]);
  const items: MenuItem[] = [
    mode === "canvas"
      ? { kind: "action", label: "가지런히", hint: overlaps > 0 ? `겹침 ${overlaps}` : undefined, onSelect: layoutCommands.resetPlacement }
      : { kind: "action", label: "기본 배치로", onSelect: layoutCommands.resetPlacement },
    { kind: "action", label: "크기 모두 고르게", disabled: mode !== "dock" || !hasDock, disabledReason: mode !== "dock" ? "도킹 배치에서만 쓸 수 있습니다" : "고를 도킹 배치가 없습니다", onSelect: equalizeDockSizes },
    { kind: "separator" },
    { kind: "action", label: "배치 되돌리기", shortcut: "Ctrl+Z", disabled: !canUndo, disabledReason: "되돌릴 배치 변경이 없습니다", onSelect: () => useLayoutStore.getState().undoArrangement() },
    { kind: "action", label: "배치 다시 하기", shortcut: "Ctrl+Shift+Z", disabled: !canRedo, disabledReason: "되돌린 배치가 없습니다", onSelect: () => useLayoutStore.getState().redoArrangement() },
  ];
  return (
    <div ref={root} className="contents">
      <button type="button" className="tb-btn aria-expanded:bg-accent-soft aria-expanded:text-accent" aria-label="배치" title="창 배치" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((now) => !now)}>
        <DockIcon />
        {mode === "canvas" && overlaps > 0 && <Badge tone="warning">겹침 {overlaps}</Badge>}
      </button>
      {open && <Menu label="배치" root={root} items={items} onClose={() => setOpen(false)}>
        <div className="layout-mode-control" onKeyDown={(event) => event.stopPropagation()}>
          <span id="layout-mode-label">창 배치 방식</span>
          <div role="group" aria-labelledby="layout-mode-label" className="ui-seg layout-mode-segments" data-size="sm">
            <button type="button" className="ui-seg-item" aria-pressed={mode === "dock"} onClick={() => setLayoutMode("dock")}>도킹</button>
            <button type="button" className="ui-seg-item" aria-pressed={mode === "canvas"} onClick={() => setLayoutMode("canvas")}>캔버스</button>
          </div>
        </div>
      </Menu>}
    </div>
  );
}
