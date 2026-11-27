import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSymbolInfo } from "../../api/queries";
import type { GroupNode } from "../../layout/dock/tree";
import type { WindowId } from "../../layout/kinds";
import type { Rect } from "../../layout/placement";
import { PERIOD_LABEL } from "../../lib/symbol";
import { chartNumber, chartWindows, useCell, useLayoutStore, useWindowName, type WindowState } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { applySymbolDrop, hasDraggedSymbol, isSymbolDropKind, readDraggedSymbol, useSymbolDragStore } from "../../stores/symbolDrag";
import { ChevronIcon, CloseIcon } from "../icons";
import { IntegratedBadge } from "../market-window/parts";
import { ScreenerBadge } from "../screener/ScreenerPanel";
import { Menu, type MenuItem } from "../menu/Menu";
import { AddWindowMenu } from "./AddWindowMenu";
import type { DockInteraction } from "./dockInteraction";
import { WINDOW_CONTENT } from "./contents";
import { LinkDot } from "./LinkDot";
import { closeWindow, LAST_CHART_REASON } from "./manage";
import { SymbolDropOverlay } from "./SymbolDragOverlay";
import { focusWithoutActivation, revealTab, tabLabel } from "./focus";

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
  return <><span className="dock-tab-name">{name}</span>{window.kind === "screener" && <ScreenerBadge id={window.id} />}<IntegratedBadge id={window.id} kind={window.kind} /></>;
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

type StripOverflow = { overflowing: boolean; hiddenBefore: boolean; hiddenAfter: boolean };
const NO_OVERFLOW: StripOverflow = { overflowing: false, hiddenBefore: false, hiddenAfter: false };

function useStripOverflow(scroller: RefObject<HTMLDivElement | null>, tabs: string): StripOverflow {
  const [overflow, setOverflow] = useState(NO_OVERFLOW);
  useLayoutEffect(() => {
    const strip = scroller.current;
    if (!strip) return;
    const measure = () => {
      const next: StripOverflow = { overflowing: strip.scrollWidth > strip.clientWidth, hiddenBefore: strip.scrollLeft > 1, hiddenAfter: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1 };
      setOverflow((now) => (now.overflowing === next.overflowing && now.hiddenBefore === next.hiddenBefore && now.hiddenAfter === next.hiddenAfter ? now : next));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    Array.from(strip.children).forEach((tab) => observer.observe(tab));
    const turnWheel = (event: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
    };
    strip.addEventListener("scroll", measure, { passive: true });
    strip.addEventListener("wheel", turnWheel, { passive: false });
    measure();
    return () => {
      observer.disconnect();
      strip.removeEventListener("scroll", measure);
      strip.removeEventListener("wheel", turnWheel);
    };
  }, [scroller, tabs]);
  return overflow;
}

function TabListMenu({ group, onSelect }: { group: GroupNode; onSelect(tab: WindowId): void }) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const items: MenuItem[] = group.tabs.map((tab) => ({ kind: "radio", label: tabLabel(tab), checked: tab === group.active, onSelect: () => onSelect(tab) }));
  return (
    <div ref={root} className="contents">
      <button type="button" className="dock-tab-list" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((now) => !now)}>탭 {group.tabs.length}개<ChevronIcon /></button>
      {open && <Menu label="탭 목록" root={root} items={items} onClose={() => setOpen(false)} />}
    </div>
  );
}

const TAB_KEYS: Record<string, (index: number, count: number) => number> = {
  ArrowLeft: (index, count) => (index + count - 1) % count,
  ArrowRight: (index, count) => (index + 1) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

export function DockGroup({ group, rect, number, interaction, maximized, onToggleMaximize }: { group: GroupNode; rect: Rect; number: number; interaction: Pick<DockInteraction, "selectTab" | "keyTab" | "pressTab" | "contextTab" | "grabbed">; maximized: boolean; onToggleMaximize(): void }) {
  const windows = useLayoutStore((s) => s.layout.windows);
  const activeCell = useSelectionStore((s) => s.activeCell);
  const dragPayload = useSymbolDragStore((s) => s.payload);
  const dragTarget = useSymbolDragStore((s) => s.target);
  const shown = windows.find((w) => w.id === group.active);
  const strip = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const stripOverflow = useStripOverflow(strip, group.tabs.join(" "));
  useLayoutEffect(() => {
    const selected = strip.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]');
    if (selected) revealTab(selected);
  }, [group.active, group.tabs.length, stripOverflow.overflowing]);
  const shownId = shown?.id ?? null;
  const shownKind = shown?.kind ?? null;
  useEffect(() => {
    const el = panelRef.current;
    if (!el || shownId === null || shownKind === null || !isSymbolDropKind(shownKind)) return;
    const onDragOver = (event: DragEvent) => {
      if (!hasDraggedSymbol(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      useSymbolDragStore.getState().setTarget({ windowId: shownId, kind: shownKind, surface: "panel" });
    };
    const onDragLeave = (event: DragEvent) => {
      if (!el.contains(event.relatedTarget as Node | null)) {
        const current = useSymbolDragStore.getState().target;
        if (current?.windowId === shownId && current.surface === "panel") useSymbolDragStore.getState().setTarget(null);
      }
    };
    const onDrop = (event: DragEvent) => {
      const payload = readDraggedSymbol(event.dataTransfer);
      if (!payload) return;
      event.preventDefault();
      applySymbolDrop(shownId, shownKind, payload, "panel");
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, [shownId, shownKind]);
  if (!shown) return null;
  const { overflow } = WINDOW_CONTENT[shown.kind];
  const select = interaction.selectTab;
  const panelDropActive = dragPayload !== null && dragTarget?.surface === "panel" && dragTarget.windowId === shown.id;
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
    <div data-dock-group={group.id} data-kind={shown.kind} data-active-cell={shown.id === activeCell ? "" : undefined} data-symbol-drop-active={panelDropActive ? "" : undefined} className="dock-group"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <div className="dock-tabs" onDoubleClick={(event) => { if (!(event.target instanceof Element) || !event.target.closest("button, .link-dot")) onToggleMaximize(); }}>
        <div className="dock-tab-viewport" data-hidden-before={stripOverflow.hiddenBefore ? "" : undefined} data-hidden-after={stripOverflow.hiddenAfter ? "" : undefined}>
          <div ref={strip} role="tablist" aria-label={`창 묶음 ${number}`} className="dock-tab-scroll">
            {group.tabs.map((tab) => {
              const window = windows.find((w) => w.id === tab);
              if (!window) return null;
              const selected = tab === group.active;
              const canDropTab = isSymbolDropKind(window.kind);
              const tabDropActive = dragPayload !== null && dragTarget?.surface === "tab" && dragTarget.windowId === tab;
              return (
                <span key={tab} className="dock-tab-group" data-selected={selected ? "" : undefined} data-active-cell={tab === activeCell ? "" : undefined} data-grabbed={tab === interaction.grabbed ? "" : undefined}
                  data-symbol-drop-target={tabDropActive ? "" : undefined}
                  onDragOver={canDropTab ? (event) => {
                    if (!hasDraggedSymbol(event.dataTransfer)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "copy";
                    useSymbolDragStore.getState().setTarget({ windowId: tab, kind: window.kind, surface: "tab" });
                  } : undefined}
                  onDragLeave={canDropTab ? (event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      const current = useSymbolDragStore.getState().target;
                      if (current?.windowId === tab && current.surface === "tab") useSymbolDragStore.getState().setTarget(null);
                    }
                  } : undefined}
                  onDrop={canDropTab ? (event) => {
                    const payload = readDraggedSymbol(event.dataTransfer);
                    if (!payload) return;
                    event.preventDefault();
                    event.stopPropagation();
                    applySymbolDrop(tab, window.kind, payload, "tab");
                  } : undefined}>
                  <button id={tabId(tab)} type="button" role="tab" data-window-id={tab} data-active-cell={tab === activeCell ? "" : undefined}
                    aria-selected={selected} aria-controls={selected ? panelId(group.id) : undefined} tabIndex={selected ? 0 : -1}
                    className="dock-tab" onClick={() => select(tab)} onKeyDown={(event) => move(event, tab)}
                    onPointerDown={(event) => interaction.pressTab(event, tab)} onContextMenu={(event) => interaction.contextTab(event, tab)} onDragStart={(event) => event.preventDefault()}>
                    <TabLabel window={window} />
                  </button>
                  <LinkDot window={window} selected={selected} />
                  <CloseTab window={window} selected={selected} onClosed={() => focusShownTab(group.id)} />
                </span>
              );
            })}
          </div>
        </div>
        {stripOverflow.overflowing && <TabListMenu group={group} onSelect={select} />}
        <AddWindowMenu targetGroup={group.id} />
        {maximized && <button type="button" className="dock-restore" aria-label="원래 크기로" title="원래 크기로" onClick={onToggleMaximize}>↙</button>}
      </div>
      <div ref={panelRef} id={panelId(group.id)} role="tabpanel" aria-labelledby={tabId(shown.id)} data-window-id={shown.id} className={`dock-panel ${overflow === "auto" ? "overflow-auto" : "overflow-hidden"}`} />
      {panelDropActive && dragPayload && <SymbolDropOverlay kind={shown.kind} payload={dragPayload} />}
    </div>
  );
}
