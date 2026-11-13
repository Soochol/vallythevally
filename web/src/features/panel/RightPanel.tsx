import { type ComponentType, type KeyboardEvent, type PointerEvent, useRef } from "react";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { type RightPanel as View, useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { ObjectList } from "../drawings/ObjectList";
import { DRAWING_ICONS, FunnelIcon, Icon, IndicatorIcon, StarIcon } from "../icons";
import { IndicatorInspector } from "../indicator-inspector/IndicatorInspector";
import { ScreenerBadge, ScreenerPanel } from "../screener/ScreenerPanel";
import { desktopPanelWidth } from "../watch/columns";
import { StatusBar } from "../status/StatusBar";
import { WatchPanel } from "../watch/Watchlist";

const ObjectsIcon = () => <Icon path={DRAWING_ICONS.objects} />;

const VIEWS: Record<View, { label: string; RailIcon: ComponentType; Content: ComponentType }> = {
  watch: { label: "관심종목", RailIcon: StarIcon, Content: WatchPanel },
  screener: { label: "스크리너", RailIcon: FunnelIcon, Content: ScreenerPanel },
  objects: { label: "개체", RailIcon: ObjectsIcon, Content: ObjectList },
  indicators: { label: "지표", RailIcon: IndicatorIcon, Content: IndicatorInspector },
};
const VIEW_ORDER = ["watch", "screener", "objects", "indicators"] as const satisfies readonly View[];

function useRailViews(): readonly View[] {
  const inspector = useUiStore((s) => s.prefs.indicatorWindow === "inspector");
  return inspector ? VIEW_ORDER : VIEW_ORDER.filter((view) => view !== "indicators");
}

const PANEL_MIN_WIDTH = 392;
const PANEL_MAX_SHARE = 0.55;
const RESIZE_KEY_STEP = 16;

function usePanelMinWidth(): number {
  const columns = useUiStore((s) => s.prefs.watchColumns);
  return Math.max(PANEL_MIN_WIDTH, desktopPanelWidth(columns));
}

const panelMaxWidth = (min: number) => Math.max(min, Math.floor(window.innerWidth * PANEL_MAX_SHARE));
const clampPanelWidth = (width: number, min: number) => Math.round(Math.min(Math.max(width, min), panelMaxWidth(min)));

export function useRightPanelWidth(): number {
  const collapsed = useUiStore((s) => s.prefs.watchCollapsed);
  const saved = useUiStore((s) => s.prefs.panelWidth);
  const dragging = useSelectionStore((s) => s.panelDragWidth);
  const min = usePanelMinWidth();
  if (collapsed) return 0;
  return Math.max(min, dragging ?? saved ?? min);
}

export function RightPanel() {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const collapsed = useUiStore((s) => s.prefs.watchCollapsed);
  const view = useUiStore((s) => s.prefs.rightPanel);
  if (!desktop) return null;
  const { Content } = VIEWS[view];
  return (
    <>
      <PanelRail view={view} open={!collapsed} />
      {!collapsed && <PanelResizer />}
      {!collapsed && (
        <div data-chart-control className="right-panel ui-island absolute bottom-[var(--island-gap)] right-[calc(var(--island-gap)*2+var(--rail-w))] top-[var(--panel-top,var(--island-gap))] z-10 flex w-[var(--watch-w)] min-h-0 min-w-0 flex-col overflow-hidden rounded-xl">
          <div id="right-tab-content" role="tabpanel" aria-labelledby={`right-tab-${view}`} className={`flex min-h-0 min-w-0 flex-1 flex-col ${view === "screener" || view === "indicators" ? "overflow-hidden" : "overflow-auto"}`}><Content /></div>
          <StatusBar />
        </div>
      )}
    </>
  );
}

function PanelResizer() {
  const min = usePanelMinWidth();
  const width = useRightPanelWidth();
  const dragging = useSelectionStore((s) => s.panelDragWidth !== null);
  const drag = useRef<{ pointer: number; startX: number; startWidth: number } | null>(null);
  const shown = clampPanelWidth(width, min);
  const save = (next: number | null) => useUiStore.getState().setPanelWidth(next === null || next === min ? null : next);
  const finish = (commit: boolean) => {
    if (!drag.current) return;
    drag.current = null;
    document.documentElement.classList.remove("panel-resizing");
    const selection = useSelectionStore.getState();
    if (commit && selection.panelDragWidth !== null) save(selection.panelDragWidth);
    selection.setPanelDragWidth(null);
  };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, startX: event.clientX, startWidth: shown };
    document.documentElement.classList.add("panel-resizing");
    useSelectionStore.getState().setPanelDragWidth(shown);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    useSelectionStore.getState().setPanelDragWidth(clampPanelWidth(drag.current.startWidth + drag.current.startX - event.clientX, min));
  };
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === "ArrowLeft" ? shown + RESIZE_KEY_STEP : event.key === "ArrowRight" ? shown - RESIZE_KEY_STEP : event.key === "Home" ? min : event.key === "End" ? panelMaxWidth(min) : null;
    if (next === null) return;
    event.preventDefault();
    save(clampPanelWidth(next, min));
  };
  return (
    <div data-chart-control role="separator" aria-orientation="vertical" aria-label="오른쪽 패널 폭" aria-valuenow={shown} aria-valuemin={min} aria-valuemax={panelMaxWidth(min)} tabIndex={0}
      title="끌어서 패널 폭 조절 · 두 번 눌러 기본 폭" data-dragging={dragging ? "" : undefined}
      onPointerDown={start} onPointerMove={move} onPointerUp={() => finish(true)} onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(true)}
      onDoubleClick={() => save(null)} onKeyDown={step}
      className="panel-resizer absolute bottom-[var(--island-gap)] right-[calc(var(--island-gap)*2+var(--rail-w)+var(--watch-w))] top-[var(--panel-top,var(--island-gap))] z-20 w-[var(--island-gap)] cursor-col-resize touch-none" />
  );
}

function PanelRail({ view, open }: { view: View; open: boolean }) {
  const show = useSelectionStore.getState().showRightPanel;
  const views = useRailViews();
  const choose = (to: View) => {
    if (open && to === view) useUiStore.getState().toggleWatch();
    else show(to);
  };
  const move = (event: KeyboardEvent<HTMLButtonElement>, from: View) => {
    const index = views.indexOf(from);
    const count = views.length;
    const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : event.key === "ArrowDown" ? (index + 1) % count : event.key === "ArrowUp" ? (index + count - 1) % count : null;
    if (next === null) return;
    event.preventDefault();
    const to = views[next]!;
    show(to);
    document.getElementById(`right-tab-${to}`)?.focus();
  };
  return (
    <nav data-chart-control role="tablist" aria-label="오른쪽 패널" aria-orientation="vertical" className="panel-rail ui-island absolute bottom-[var(--island-gap)] right-[var(--island-gap)] top-[var(--panel-top,var(--island-gap))] z-10 flex w-[var(--rail-w)] flex-col items-center gap-1 rounded-xl py-1.5">
      {views.map((to) => {
        const { label, RailIcon } = VIEWS[to];
        const current = open && to === view;
        return (
          <button key={to} id={`right-tab-${to}`} type="button" role="tab" aria-selected={current} aria-controls={current ? "right-tab-content" : undefined} tabIndex={to === view ? 0 : -1}
            title={current ? `${label} 접기 (Alt+W)` : label} onClick={() => choose(to)} onKeyDown={(event) => move(event, to)}
            className={`relative grid h-9 w-9 place-items-center rounded-m ${current ? "bg-accent-soft text-accent" : "text-text-2 hover:bg-raised hover:text-text"}`}>
            <RailIcon /><span className="sr-only">{label}</span>{to === "screener" && <ScreenerBadge />}
          </button>
        );
      })}
    </nav>
  );
}
