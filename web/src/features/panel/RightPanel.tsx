import type { ComponentType, ReactNode } from "react";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { type RightPanel as View, useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { ObjectList } from "../drawings/ObjectList";
import { ChevronRightIcon, DrawingsIcon, ListIcon } from "../icons";
import { desktopPanelWidth } from "../watch/columns";
import { WatchPanel } from "../watch/Watchlist";

const RAIL_WIDTH = 44;

interface ViewSpec {
  label: string;
  icon: ReactNode;
  Content: ComponentType;
}

const VIEWS: Record<View, ViewSpec> = {
  watch: { label: "관심종목", icon: <ListIcon size={19} />, Content: WatchPanel },
  objects: { label: "개체", icon: <DrawingsIcon size={19} />, Content: ObjectList },
};
const VIEW_ORDER = Object.keys(VIEWS) as View[];

export function useRightPanelWidth(): number {
  const collapsed = useUiStore((s) => s.prefs.watchCollapsed);
  const columns = useUiStore((s) => s.prefs.watchColumns);
  if (collapsed) return RAIL_WIDTH;
  return RAIL_WIDTH + desktopPanelWidth(columns);
}

export function RightPanel() {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const collapsed = useUiStore((s) => s.prefs.watchCollapsed);
  const view = useSelectionStore((s) => s.rightPanel);
  if (!desktop) return null;
  const { Content } = VIEWS[view];
  return (
    <div className="flex min-h-0 min-w-0 border-l border-line bg-bg [grid-area:watch]">
      {!collapsed && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Content />
        </div>
      )}
      <Rail view={view} collapsed={collapsed} />
    </div>
  );
}

function Rail({ view, collapsed }: { view: View; collapsed: boolean }) {
  const toggle = useUiStore((s) => s.toggleWatch);
  const show = useSelectionStore((s) => s.showRightPanel);
  return (
    <nav aria-label="오른쪽 패널" className="flex w-11 flex-none flex-col items-center gap-1 border-l border-line py-1.5">
      {VIEW_ORDER.map((to) => {
        const { label, icon } = VIEWS[to];
        const open = !collapsed && to === view;
        return (
          <button
            key={to}
            type="button"
            title={open ? `${label} 접기` : label}
            aria-pressed={open}
            onClick={() => (open ? toggle() : show(to))}
            className={`relative grid h-10 w-10 place-items-center rounded-m ${open ? "bg-accent-soft text-accent" : "text-text-2 hover:bg-raised hover:text-text"}`}
          >
            <span className="sr-only">{label}</span>
            {icon}
          </button>
        );
      })}
      <span className="flex-1" />
      <button
        type="button"
        className="icon-btn h-8 w-8"
        title={collapsed ? "패널 펴기 (Alt+W)" : "패널 접기 (Alt+W)"}
        aria-label={collapsed ? "패널 펴기" : "패널 접기"}
        aria-expanded={!collapsed}
        onClick={toggle}
      >
        <ChevronRightIcon flip={collapsed} />
      </button>
    </nav>
  );
}
