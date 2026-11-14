import { useQueryClient } from "@tanstack/react-query";
import { Fragment, type KeyboardEvent, useState } from "react";
import { useSymbolInfo } from "../../api/queries";
import type { GroupNode } from "../../layout/dock/tree";
import { WINDOW_KINDS, type WindowId } from "../../layout/kinds";
import type { Rect } from "../../layout/placement";
import { PERIOD_LABEL } from "../../lib/symbol";
import { chartNumber, chartWindows, useCell, useLayoutStore, type WindowState } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { CloseIcon } from "../icons";
import { ScreenerBadge } from "../screener/ScreenerPanel";
import { WINDOW_CONTENT } from "./contents";
import { LinkDot } from "./LinkDot";
import { closeWindow, LAST_CHART_REASON } from "./manage";

export const tabId = (window: WindowId) => `window-tab-${window}`;
const panelId = (group: string) => `window-panel-${group}`;

function ChartTabLabel({ id }: { id: WindowId }) {
  const cell = useCell(id);
  const name = useSymbolInfo(cell.symbol).data?.name ?? cell.symbol;
  const [seen, setSeen] = useState(cell.symbol);
  const [flash, setFlash] = useState(0);
  if (seen !== cell.symbol) {
    setSeen(cell.symbol);
    setFlash((n) => n + 1);
  }
  return (
    <>
      <span className="dock-tab-name">{name}</span><span className="dock-tab-sub">{PERIOD_LABEL[cell.period]}</span>
      {flash > 0 && <span key={flash} className="dock-tab-flash" aria-hidden="true" onAnimationEnd={() => setFlash(0)} />}
    </>
  );
}

function TabLabel({ window }: { window: WindowState }) {
  if (window.kind === "chart") return <ChartTabLabel id={window.id} />;
  return <><span className="dock-tab-name">{WINDOW_KINDS[window.kind].name}</span>{window.kind === "screener" && <ScreenerBadge />}</>;
}

function CloseTabButton({ id, name, reason, selected, onClosed }: { id: WindowId; name: string; reason: string | null; selected: boolean; onClosed(): void }) {
  const client = useQueryClient();
  const label = `${name} 닫기`;
  return (
    <button type="button" className="dock-tab-close" aria-label={label} title={reason ?? label} disabled={reason !== null} tabIndex={selected ? 0 : -1}
      onClick={() => { if (closeWindow(id, name, client)) onClosed(); }}>
      <CloseIcon size={12} />
    </button>
  );
}

function ChartCloseButton({ id, selected, onClosed }: { id: WindowId; selected: boolean; onClosed(): void }) {
  const cell = useCell(id);
  const number = useLayoutStore((s) => chartNumber(s.layout, id));
  const alone = useLayoutStore((s) => chartWindows(s.layout).length <= 1);
  const name = useSymbolInfo(cell.symbol).data?.name ?? cell.symbol;
  return <CloseTabButton id={id} name={`칸 ${number} ${name}`} reason={alone ? LAST_CHART_REASON : null} selected={selected} onClosed={onClosed} />;
}

function CloseTab({ window, selected, onClosed }: { window: WindowState; selected: boolean; onClosed(): void }) {
  if (window.kind === "chart") return <ChartCloseButton id={window.id} selected={selected} onClosed={onClosed} />;
  return <CloseTabButton id={window.id} name={WINDOW_KINDS[window.kind].name} reason={null} selected={selected} onClosed={onClosed} />;
}

function focusShownTab(group: string) {
  requestAnimationFrame(() => {
    const tabs = document.querySelector(`[data-dock-group="${group}"]`) ?? document;
    tabs.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus();
  });
}

const TAB_KEYS: Record<string, (index: number, count: number) => number> = {
  ArrowLeft: (index, count) => (index + count - 1) % count,
  ArrowRight: (index, count) => (index + 1) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

export function DockGroup({ group, rect, number }: { group: GroupNode; rect: Rect; number: number }) {
  const windows = useLayoutStore((s) => s.layout.windows);
  const activeCell = useSelectionStore((s) => s.activeCell);
  const shown = windows.find((w) => w.id === group.active);
  if (!shown) return null;
  const { Content, overflow } = WINDOW_CONTENT[shown.kind];
  const select = (window: WindowId) => {
    useLayoutStore.getState().selectTab(window);
    if (windows.some((w) => w.id === window && w.kind === "chart")) useSelectionStore.getState().setActiveCell(window);
  };
  const move = (event: KeyboardEvent<HTMLButtonElement>, from: WindowId) => {
    const step = TAB_KEYS[event.key];
    if (!step) return;
    event.preventDefault();
    const to = group.tabs[step(group.tabs.indexOf(from), group.tabs.length)]!;
    select(to);
    document.getElementById(tabId(to))?.focus();
  };
  return (
    <div data-dock-group={group.id} data-kind={shown.kind} data-active-cell={shown.id === activeCell ? "" : undefined} className="dock-group"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <div role="tablist" aria-label={`창 묶음 ${number}`} className="dock-tabs">
        {group.tabs.map((tab) => {
          const window = windows.find((w) => w.id === tab);
          if (!window) return null;
          const selected = tab === group.active;
          return (
            <Fragment key={tab}>
              <button id={tabId(tab)} type="button" role="tab" data-window-id={tab} data-active-cell={tab === activeCell ? "" : undefined}
                aria-selected={selected} aria-controls={selected ? panelId(group.id) : undefined} tabIndex={selected ? 0 : -1}
                className="dock-tab" onClick={() => select(tab)} onKeyDown={(event) => move(event, tab)}>
                <TabLabel window={window} />
              </button>
              <LinkDot window={window} selected={selected} />
              <CloseTab window={window} selected={selected} onClosed={() => focusShownTab(group.id)} />
            </Fragment>
          );
        })}
      </div>
      <div id={panelId(group.id)} role="tabpanel" aria-labelledby={tabId(shown.id)} data-window-id={shown.id} className={`dock-panel ${overflow === "auto" ? "overflow-auto" : "overflow-hidden"}`}>
        <Content key={shown.id} id={shown.id} />
      </div>
    </div>
  );
}
