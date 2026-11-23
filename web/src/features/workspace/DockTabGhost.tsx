import type { TabGrab } from "./dockInteraction";
import { tabLabel } from "./focus";

const POINTER_GAP = 12;

export function DockTabGhost({ grab }: { grab: TabGrab }) {
  return <div data-dock-ghost className="dock-tab-ghost" aria-hidden="true" style={{ transform: `translate(${grab.point.x + POINTER_GAP}px, ${grab.point.y + POINTER_GAP}px)` }}>{tabLabel(grab.window)}</div>;
}
