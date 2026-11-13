import type { ComponentType, KeyboardEvent } from "react";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { type RightPanel as View, useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { ObjectList } from "../drawings/ObjectList";
import { ExpandIcon, PanelIcon } from "../icons";
import { ScreenerBadge, ScreenerPanel } from "../screener/ScreenerPanel";
import { desktopPanelWidth } from "../watch/columns";
import { StatusBar } from "../status/StatusBar";
import { WatchPanel } from "../watch/Watchlist";

const VIEWS: Record<View, { label: string; Content: ComponentType }> = {
  watch: { label: "관심종목", Content: WatchPanel },
  screener: { label: "스크리너", Content: ScreenerPanel },
  objects: { label: "개체", Content: ObjectList },
};
const VIEW_ORDER = ["watch", "screener", "objects"] as const;

export function useRightPanelLayout(): { width: number; covers: boolean } {
  const collapsed = useUiStore((s) => s.prefs.watchCollapsed);
  const columns = useUiStore((s) => s.prefs.watchColumns);
  const view = useUiStore((s) => s.prefs.rightPanel);
  const width = useUiStore((s) => s.prefs.rightPanelWidth);
  if (collapsed) return { width: 0, covers: false };
  if (width === "wide") return { width: 640, covers: view === "screener" };
  return { width: Math.max(view === "screener" ? 392 : 336, desktopPanelWidth(columns)), covers: false };
}

export function RightPanel() {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const collapsed = useUiStore((s) => s.prefs.watchCollapsed);
  const view = useUiStore((s) => s.prefs.rightPanel);
  const wide = useUiStore((s) => s.prefs.rightPanelWidth === "wide");
  if (!desktop || collapsed) return null;
  const { Content } = VIEWS[view];
  const wideScreener = view === "screener" && wide;
  const show = useSelectionStore.getState().showRightPanel;
  const move = (event: KeyboardEvent<HTMLButtonElement>, from: View) => {
    const index = VIEW_ORDER.indexOf(from);
    const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : null;
    if (next === null) return;
    event.preventDefault();
    const to = VIEW_ORDER[next]!;
    show(to);
    document.getElementById(`right-tab-${to}`)?.focus();
  };
  return (
    <div data-chart-control data-covers={wideScreener ? "" : undefined} className={`right-panel ui-island absolute bottom-[var(--island-gap)] right-[var(--island-gap)] flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl ${wideScreener ? "left-[var(--island-gap)] top-[calc(var(--island-gap)*2+var(--island-h))] z-20" : "top-[var(--panel-top,var(--island-gap))] z-10 w-[var(--watch-w)]"}`}>
      <header data-chart-control className="flex h-10 flex-none items-center gap-1 border-b border-line px-1">
        <nav role="tablist" aria-label="오른쪽 패널" className="flex min-w-0 flex-1 items-center gap-1">
          {VIEW_ORDER.map((to) => <button key={to} id={`right-tab-${to}`} type="button" role="tab" aria-selected={to === view} aria-controls="right-tab-content" tabIndex={to === view ? 0 : -1}
            title={VIEWS[to].label} onClick={() => show(to)} onKeyDown={(event) => move(event, to)}
            className={`relative h-7 whitespace-nowrap rounded-m px-2 text-s ${to === view ? "bg-accent-soft font-semibold text-accent" : "text-text-2 hover:bg-raised"} ${to === "screener" ? "pr-5" : ""}`}>
            {VIEWS[to].label}{to === "screener" && <ScreenerBadge />}
          </button>)}
        </nav>
        <button type="button" className="icon-btn !h-7 !w-7 flex-none" data-chart-control title={wideScreener ? "오른쪽 탭으로" : wide ? "기본 너비로" : "넓게 보기"} aria-label={wideScreener ? "오른쪽 탭으로" : "넓게 보기"} aria-pressed={wide} onClick={() => useUiStore.getState().togglePanelWidth()}><ExpandIcon /></button>
        <button type="button" className="icon-btn !h-7 !w-7 flex-none" title="탭 숨기기 (Alt+W)" aria-label="탭 숨기기" aria-expanded={true} onClick={() => useUiStore.getState().toggleWatch()}><PanelIcon /></button>
      </header>
      <div id="right-tab-content" role="tabpanel" aria-labelledby={`right-tab-${view}`} className={`flex min-h-0 min-w-0 flex-1 flex-col ${view === "screener" ? "overflow-hidden" : "overflow-auto"}`}>{view === "screener" ? <ScreenerPanel wide={wide} onReturn={() => useUiStore.getState().togglePanelWidth()} /> : <Content />}</div>
      <StatusBar />
    </div>
  );
}
