import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { useSymbolInfo } from "../../api/queries";
import type { GroupNode } from "../../layout/dock/tree";
import type { WindowId } from "../../layout/kinds";
import type { Rect } from "../../layout/placement";
import { PERIOD_LABEL } from "../../lib/symbol";
import { chartNumber, chartWindows, useCell, useLayoutStore, useWindowName, type WindowState } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { CloseIcon } from "../icons";
import { IntegratedBadge, showsIntegratedBadge } from "../market-window/parts";
import { ScreenerBadge } from "../screener/ScreenerPanel";
import { AddWindowMenu } from "./AddWindowMenu";
import type { DockInteraction } from "./dockInteraction";
import { WINDOW_CONTENT } from "./contents";
import { LinkDot } from "./LinkDot";
import { closeWindow, LAST_CHART_REASON } from "./manage";
import { WindowSymbol } from "./WindowSymbol";
import { focusWithoutActivation, revealTab } from "./focus";

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

function OtherTabLabel({ window }: { window: WindowState }) {
  const name = useWindowName(window);
  return <><span className="dock-tab-name">{name}</span>{window.kind === "screener" && <ScreenerBadge id={window.id} />}{showsIntegratedBadge(window.kind) && <IntegratedBadge />}</>;
}

function TabLabel({ window }: { window: WindowState }) {
  return window.kind === "chart" ? <ChartTabLabel id={window.id} /> : <OtherTabLabel window={window} />;
}

function CloseTabButton({ id, name, reason, selected, onClosed }: { id: WindowId; name: string; reason: string | null; selected: boolean; onClosed(): void }) {
  const label = `${name} 닫기`;
  return (
    <button type="button" className="dock-tab-close" aria-label={label} title={reason ?? label} disabled={reason !== null} tabIndex={selected ? 0 : -1}
      onClick={() => { if (closeWindow(id, name)) onClosed(); }}>
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

function OtherCloseButton({ window, selected, onClosed }: { window: WindowState; selected: boolean; onClosed(): void }) {
  return <CloseTabButton id={window.id} name={useWindowName(window)} reason={null} selected={selected} onClosed={onClosed} />;
}

function CloseTab({ window, selected, onClosed }: { window: WindowState; selected: boolean; onClosed(): void }) {
  return window.kind === "chart" ? <ChartCloseButton id={window.id} selected={selected} onClosed={onClosed} /> : <OtherCloseButton window={window} selected={selected} onClosed={onClosed} />;
}

function focusShownTab(group: string) {
  requestAnimationFrame(() => {
    const tabs = document.querySelector(`[data-dock-group="${group}"]`) ?? document;
    focusWithoutActivation(tabs.querySelector<HTMLElement>('[role=tab][aria-selected=true]'));
  });
}

const TAB_KEYS: Record<string, (index: number, count: number) => number> = {
  ArrowLeft: (index, count) => (index + count - 1) % count,
  ArrowRight: (index, count) => (index + 1) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

export function DockGroup({ group, rect, number, interaction, maximized, onToggleMaximize }: { group: GroupNode; rect: Rect; number: number; interaction: Pick<DockInteraction, "selectTab" | "keyTab" | "pressTab" | "contextTab">; maximized: boolean; onToggleMaximize(): void }) {
  const windows = useLayoutStore((s) => s.layout.windows);
  const activeCell = useSelectionStore((s) => s.activeCell);
  const shown = windows.find((w) => w.id === group.active);
  const strip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const selected = strip.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]');
    if (selected) revealTab(selected);
  }, [group.active, group.tabs.length]);
  if (!shown) return null;
  const { overflow } = WINDOW_CONTENT[shown.kind];
  const select = interaction.selectTab;
  const move = (event: KeyboardEvent<HTMLButtonElement>, from: WindowId) => {
    if (interaction.keyTab(event, from)) return;
    const step = TAB_KEYS[event.key];
    if (!step) return;
    event.preventDefault();
    const to = group.tabs[step(group.tabs.indexOf(from), group.tabs.length)]!;
    select(to);
    focusWithoutActivation(document.getElementById(tabId(to)));
  };
  return (
    <div data-dock-group={group.id} data-kind={shown.kind} data-active-cell={shown.id === activeCell ? "" : undefined} className="dock-group"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <div ref={strip} role="tablist" aria-label={`창 묶음 ${number}`} className="dock-tabs" onDoubleClick={(event) => { if (!(event.target instanceof Element) || !event.target.closest("button, .link-dot")) onToggleMaximize(); }}>
        {group.tabs.map((tab) => {
          const window = windows.find((w) => w.id === tab);
          if (!window) return null;
          const selected = tab === group.active;
          return (
            <span key={tab} className="dock-tab-group">
              <button id={tabId(tab)} type="button" role="tab" data-window-id={tab} data-active-cell={tab === activeCell ? "" : undefined}
                aria-selected={selected} aria-controls={selected ? panelId(group.id) : undefined} tabIndex={selected ? 0 : -1}
                className="dock-tab" onClick={() => select(tab)} onKeyDown={(event) => move(event, tab)}
                onPointerDown={(event) => interaction.pressTab(event, tab)} onContextMenu={(event) => interaction.contextTab(event, tab)} onDragStart={(event) => event.preventDefault()}>
                <TabLabel window={window} />
              </button>
              <LinkDot window={window} selected={selected} />
              <WindowSymbol window={window} selected={selected} />
              <CloseTab window={window} selected={selected} onClosed={() => focusShownTab(group.id)} />
            </span>
          );
        })}
        <AddWindowMenu targetGroup={group.id} />
        {maximized && <button type="button" className="dock-restore" aria-label="원래 크기로" title="원래 크기로" onClick={onToggleMaximize}>↙</button>}
      </div>
      <div id={panelId(group.id)} role="tabpanel" aria-labelledby={tabId(shown.id)} data-window-id={shown.id} className={`dock-panel ${overflow === "auto" ? "overflow-auto" : "overflow-hidden"}`} />
    </div>
  );
}
