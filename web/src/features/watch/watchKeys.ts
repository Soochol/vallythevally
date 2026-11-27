import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import type { Watchlist } from "../../api/generated/Watchlist";
import { symbolInfoQuery } from "../../api/queries";
import type { WindowId } from "../../layout/kinds";
import { isTypingTarget } from "../../lib/typingTarget";
import { rowKey, type WatchRowRef, watchSections } from "../../lib/watchlist";
import { activeWatchWindow, registerWatchWindow } from "../../stores/activeWindow";
import { useAccountStore } from "../../stores/account";
import { useLayoutStore, watchedSymbol } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { ownsChartKeyboard } from "../overlay/topLayer";
import { useWizardStore, wizardVisible } from "../setup-wizard/wizardOpen";

export const WATCH_REPEAT_COMMIT_MS = 150;

export type WatchKeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented" | "repeat" | "target" | "preventDefault">;

export interface RowPreviewStore {
  get(): string | null;
  set(key: string | null): void;
  subscribe(key: string, listener: () => void): () => void;
}

export function createRowPreviewStore(): RowPreviewStore {
  let current: string | null = null;
  const listeners = new Map<string, Set<() => void>>();
  const notifyKey = (key: string) => {
    const bucket = listeners.get(key);
    if (bucket) for (const listener of bucket) listener();
  };
  const notifyAll = () => {
    for (const bucket of listeners.values()) for (const listener of bucket) listener();
  };
  return {
    get: () => current,
    set: (next) => {
      if (next === current) return;
      const previous = current;
      current = next;
      if (previous === null || next === null) notifyAll();
      else {
        notifyKey(previous);
        notifyKey(next);
      }
    },
    subscribe: (key, listener) => {
      let bucket = listeners.get(key);
      if (!bucket) {
        bucket = new Set();
        listeners.set(key, bucket);
      }
      bucket.add(listener);
      return () => {
        bucket.delete(listener);
        if (bucket.size === 0) listeners.delete(key);
      };
    },
  };
}

export function createRowSelectionStore(): RowPreviewStore {
  let current: string | null = null;
  const listeners = new Map<string, Set<() => void>>();
  const notifyKey = (key: string) => {
    const bucket = listeners.get(key);
    if (bucket) for (const listener of bucket) listener();
  };
  return {
    get: () => current,
    set: (next) => {
      if (next === current) return;
      const previous = current;
      current = next;
      if (previous !== null) notifyKey(previous);
      if (next !== null) notifyKey(next);
    },
    subscribe: (key, listener) => {
      let bucket = listeners.get(key);
      if (!bucket) {
        bucket = new Set();
        listeners.set(key, bucket);
      }
      bucket.add(listener);
      return () => {
        bucket.delete(listener);
        if (bucket.size === 0) listeners.delete(key);
      };
    },
  };
}

export function visibleWatchRows(list: Watchlist, collapsed: readonly string[]): WatchRowRef[] {
  const hidden = new Set(collapsed);
  const rows: WatchRowRef[] = [];
  for (const section of watchSections(list)) {
    const groupId = section.group?.id ?? null;
    if (groupId !== null && hidden.has(groupId)) continue;
    for (const code of section.symbols) rows.push({ code, groupId });
  }
  return rows;
}

export function nextWatchRow(
  rows: readonly WatchRowRef[],
  step: -1 | 1,
  state: { previewKey: string | null; watched: SymbolCode | null; focusedKey: string | null },
): WatchRowRef | null {
  if (rows.length === 0) return null;
  let at = -1;
  if (state.previewKey !== null) {
    at = rows.findIndex((row) => rowKey(row) === state.previewKey);
  }
  if (at < 0 && state.watched !== null) {
    if (state.focusedKey !== null) {
      at = rows.findIndex((row) => rowKey(row) === state.focusedKey && row.code === state.watched);
    }
    if (at < 0) {
      at = rows.findIndex((row) => row.code === state.watched);
    }
  }
  if (at < 0) return step === 1 ? rows[0]! : rows[rows.length - 1]!;
  const next = Math.max(0, Math.min(rows.length - 1, at + step));
  return next === at ? null : rows[next]!;
}

export function resolveWatchRow(
  sender: WindowId,
  rows: readonly WatchRowRef[],
  step: -1 | 1,
  state: { previewKey: string | null; focusedKey: string | null },
): WatchRowRef | null {
  const { layout, groupSymbols } = useLayoutStore.getState();
  const watched = watchedSymbol(layout, sender, useSelectionStore.getState().activeCell, groupSymbols);
  return nextWatchRow(rows, step, { previewKey: state.previewKey, watched, focusedKey: state.focusedKey });
}

export function watchKeyStep(event: WatchKeyEvent): -1 | 1 | null {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return null;
  if (wizardVisible(useAccountStore.getState().status, useWizardStore.getState().open)) return null;
  if (useSelectionStore.getState().dialog !== null || ownsChartKeyboard(event) || isTypingTarget(event.target)) return null;
  if (event.target instanceof Element && event.target.closest("[role=dialog], [role=alertdialog], [role=menu]") !== null) return null;
  return event.key === "ArrowDown" ? 1 : -1;
}

function focusedRowKey(scroller: HTMLElement | null): string | null {
  const active = document.activeElement;
  if (!scroller || !(active instanceof Element) || !scroller.contains(active)) return null;
  return active.closest<HTMLElement>("li[data-row]")?.dataset.row ?? null;
}

function focusAndRevealRow(scroller: HTMLElement | null, key: string) {
  if (!scroller) return;
  const line = scroller.querySelector<HTMLElement>(`li[data-row="${CSS.escape(key)}"]`);
  const button = line?.querySelector<HTMLElement>("[data-main]");
  if (!line || !button) return;
  button.focus({ preventScroll: true });
  const room = scroller.getBoundingClientRect();
  const at = line.getBoundingClientRect();
  if (at.bottom > room.bottom) scroller.scrollTop += at.bottom - room.bottom;
  else if (at.top < room.top) scroller.scrollTop -= room.top - at.top;
}

interface UseWatchKeysOptions {
  enabled: boolean;
  sender: WindowId | null;
  list: Watchlist;
  collapsed: readonly string[];
  scroller: RefObject<HTMLElement | null>;
  preview: RowPreviewStore;
}

export function useWatchKeys({ enabled, sender, list, collapsed, scroller, preview }: UseWatchKeysOptions) {
  const queryClient = useQueryClient();
  const latest = useRef({ list, collapsed });
  latest.current = { list, collapsed };

  useEffect(() => {
    if (!enabled || sender === null) return;
    const unregister = registerWatchWindow(sender);
    let pending: WatchRowRef | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const openSymbol = (code: SymbolCode) => {
      const cellId = useSelectionStore.getState().activeCell;
      const info = queryClient.getQueryData<SymbolInfo>(symbolInfoQuery(code).queryKey);
      const { notice } = useLayoutStore.getState().sendSymbol(sender, cellId, info ?? { code });
      if (notice) useSelectionStore.getState().showToast(notice);
    };

    const commitPending = () => {
      if (pending === null) return;
      const target = pending;
      pending = null;
      clearTimer();
      openSymbol(target.code);
      preview.set(null);
    };

    const cancelPending = () => {
      if (pending === null && timer === null) return;
      pending = null;
      clearTimer();
      preview.set(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (activeWatchWindow() !== sender) return;
      if (scroller.current?.closest("[inert]") != null) return;
      const step = watchKeyStep(event);
      if (step === null) return;
      const rows = visibleWatchRows(latest.current.list, latest.current.collapsed);
      if (rows.length > 0) event.preventDefault();
      const next = resolveWatchRow(sender, rows, step, {
        previewKey: preview.get(),
        focusedKey: focusedRowKey(scroller.current),
      });
      if (next === null) return;
      const key = rowKey(next);
      if (event.repeat) {
        pending = next;
        preview.set(key);
        focusAndRevealRow(scroller.current, key);
        clearTimer();
        timer = setTimeout(commitPending, WATCH_REPEAT_COMMIT_MS);
        return;
      }
      pending = null;
      clearTimer();
      openSymbol(next.code);
      preview.set(null);
      focusAndRevealRow(scroller.current, key);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      commitPending();
    };

    const onPointerDown = () => cancelPending();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", commitPending);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      unregister();
      cancelPending();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", commitPending);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [enabled, sender, scroller, queryClient, preview]);
}
