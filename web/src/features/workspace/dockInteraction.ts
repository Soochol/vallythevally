import { type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject, useEffect, useRef, useState } from "react";
import type { DockSpace } from "../../layout/dock/geometry";
import { groupOfWindow } from "../../layout/dock/tree";
import type { WindowId } from "../../layout/kinds";
import type { DockPlacement } from "../../layout/placement";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { commandAt, evaluateDock, type DockCommand, type DockPlan } from "./dockCommands";

export type TabMenu = { window: WindowId; x: number; y: number };
type Press = { pointer: number; window: WindowId; x: number; y: number; dock: DockPlacement; layoutId: string };
type Gesture = { kind: "idle" } | { kind: "pressed"; press: Press } | { kind: "dragging"; press: Press; point: { x: number; y: number } };

export const focusTab = (id: WindowId) => requestAnimationFrame(() => document.getElementById(`window-tab-${id}`)?.focus());

function selectTab(id: WindowId) {
  const state = useLayoutStore.getState();
  state.selectTab(id);
  if (state.layout.windows.some((window) => window.id === id && window.kind === "chart")) useSelectionStore.getState().setActiveCell(id);
}

export function useDockInteraction({ root, dock, space }: { root: RefObject<HTMLElement | null>; dock: DockPlacement; space: DockSpace | null }) {
  const gesture = useRef<Gesture>({ kind: "idle" });
  const current = useRef({ dock, space });
  current.current = { dock, space };
  const [preview, setPreview] = useState<DockPlan | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const suppressedPointer = useRef<number | null>(null);
  const layoutId = useLayoutStore((s) => s.layout.id);

  const finish = (restoreFocus: boolean) => {
    const previous = gesture.current;
    gesture.current = { kind: "idle" };
    setPreview(null);
    setDragging(false);
    document.documentElement.classList.remove("dock-dragging");
    if (previous.kind !== "idle") {
      if (root.current?.hasPointerCapture(previous.press.pointer)) root.current.releasePointerCapture(previous.press.pointer);
      if (restoreFocus) focusTab(previous.press.window);
    }
    if (previous.kind === "dragging") {
      suppressedPointer.current = previous.press.pointer;
    }
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const execute = (command: DockCommand) => {
    const latest = current.current;
    if (!latest.space) return;
    const plan = evaluateDock(latest.dock, command, latest.space);
    if (plan.kind === "blocked") useSelectionStore.getState().showToast(plan.label);
    if (plan.kind === "change") {
      useLayoutStore.getState().setDock(plan.dock);
      if (useLayoutStore.getState().layout.windows.some((window) => window.id === command.window && window.kind === "chart")) useSelectionStore.getState().setActiveCell(command.window);
    } else if (plan.kind === "unchanged" && command.kind === "tab") selectTab(command.window);
    focusTab(command.window);
  };
  const executeRef = useRef(execute);
  executeRef.current = execute;

  useEffect(() => {
    const target = (event: globalThis.PointerEvent) => {
      const active = gesture.current;
      const latest = current.current;
      return active.kind !== "idle" && root.current && latest.space
        ? commandAt(root.current, latest.dock, active.press.window, { x: event.clientX, y: event.clientY }, latest.space, active.press)
        : null;
    };
    const move = (event: globalThis.PointerEvent) => {
      const active = gesture.current;
      const { dock: latest, space: room } = current.current;
      if (active.kind === "idle" || active.press.pointer !== event.pointerId || !room) return;
      if (active.kind === "pressed" && (event.clientX - active.press.x) ** 2 + (event.clientY - active.press.y) ** 2 <= 25) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const command = target(event);
      const plan = command ? evaluateDock(latest, command, room) : { kind: "unchanged" } satisfies DockPlan;
      gesture.current = { kind: "dragging", press: active.press, point: { x: event.clientX, y: event.clientY } };
      setDragging(true);
      setPreview(plan);
      setMenu(null);
      document.documentElement.classList.add("dock-dragging");
    };
    const up = (event: globalThis.PointerEvent) => {
      const active = gesture.current;
      if (active.kind === "idle" || active.press.pointer !== event.pointerId) return;
      if (active.kind === "pressed") {
        finishRef.current(false);
        selectTab(active.press.window);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const command = target(event);
      finishRef.current(false);
      if (command) executeRef.current(command);
      else focusTab(active.press.window);
    };
    const cancel = () => { if (gesture.current.kind !== "idle") finishRef.current(true); };
    const cancelPointer = (event: globalThis.PointerEvent) => {
      const active = gesture.current;
      if (active.kind !== "idle" && active.press.pointer === event.pointerId) cancel();
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (gesture.current.kind === "idle") return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      } else if (gesture.current.kind === "dragging") {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const shield = (event: Event) => {
      const fromGesture = event instanceof globalThis.PointerEvent && event.pointerId === suppressedPointer.current;
      if (event.type === "pointerdown" && fromGesture) suppressedPointer.current = null;
      const suppressClick = event.type === "click" && fromGesture && event.detail > 0;
      if (suppressClick) suppressedPointer.current = null;
      if (gesture.current.kind !== "dragging" && !suppressClick) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("pointermove", move, { capture: true, passive: false });
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancelPointer, true);
    document.addEventListener("keydown", key, true);
    const blocked = ["pointerdown", "click", "dblclick", "contextmenu", "wheel"];
    blocked.forEach((type) => document.addEventListener(type, shield, { capture: true, passive: false }));
    window.addEventListener("blur", cancel);
    return () => {
      cancel();
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancelPointer, true);
      document.removeEventListener("keydown", key, true);
      blocked.forEach((type) => document.removeEventListener(type, shield, true));
      window.removeEventListener("blur", cancel);
    };
  }, [root]);

  useEffect(() => {
    const active = gesture.current;
    if (active.kind !== "idle" && (active.press.dock !== dock || active.press.layoutId !== layoutId || !groupOfWindow(dock.root, active.press.window))) finishRef.current(true);
  }, [dock, layoutId]);

  const width = space?.area.w;
  const height = space?.area.h;
  useEffect(() => {
    const active = gesture.current;
    const latest = current.current;
    if (active.kind !== "dragging" || !root.current || !latest.space) return;
    const command = commandAt(root.current, latest.dock, active.press.window, active.point, latest.space, active.press);
    setPreview(command ? evaluateDock(latest.dock, command, latest.space) : { kind: "unchanged" });
  }, [width, height, root]);

  const pressTab = (event: PointerEvent<HTMLButtonElement>, window: WindowId) => {
    if (event.button !== 0 || !event.isPrimary || gesture.current.kind !== "idle" || !space) return;
    gesture.current = { kind: "pressed", press: { pointer: event.pointerId, window, x: event.clientX, y: event.clientY, dock, layoutId } };
    event.currentTarget.focus();
    root.current?.setPointerCapture(event.pointerId);
  };
  const openMenu = (window: WindowId, x: number, y: number) => {
    document.getElementById(`window-tab-${window}`)?.focus();
    setMenu({ window, x, y });
  };
  const contextTab = (event: MouseEvent<HTMLButtonElement>, window: WindowId) => {
    event.preventDefault();
    openMenu(window, event.clientX, event.clientY);
  };
  const keyTab = (event: KeyboardEvent<HTMLButtonElement>, window: WindowId): boolean => {
    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      openMenu(window, box.left, box.bottom);
      return true;
    }
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const group = groupOfWindow(dock.root, window);
      if (group) execute({ kind: "tab", window, group: group.id, at: Math.max(0, Math.min(group.tabs.length - 1, group.tabs.indexOf(window) + (event.key === "ArrowLeft" ? -1 : 1))) });
      return true;
    }
    return false;
  };
  return { dragging, preview, menu, setMenu, execute, pressTab, contextTab, keyTab, selectTab, lostCapture: (event: PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (active.kind !== "idle" && active.press.pointer === event.pointerId) finishRef.current(true);
  } };
}

export type DockInteraction = ReturnType<typeof useDockInteraction>;
