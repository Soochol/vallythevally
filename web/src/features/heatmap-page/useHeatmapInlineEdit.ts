import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HeatmapBoard } from "../../api/generated/HeatmapBoard";
import type { HeatmapTheme } from "../../api/generated/HeatmapTheme";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { changeThemesNow } from "../../api/heatmapThemes";
import { ApiRequestError } from "../../api/http";
import {
  addSymbolToTheme,
  createTheme,
  deleteTheme,
  importNotices,
  importWatchlistGroups,
  MAX_THEME_SYMBOLS,
  moveItem,
  moveSymbol,
  removeSymbolFromTheme,
  renameTheme,
  transferSymbol,
} from "../../lib/heatmapThemes";
import { isTypingTarget } from "../../lib/typingTarget";
import { quoteBook } from "../../stores/realtime";
import { type ToastUndo, useSelectionStore } from "../../stores/selection";
import { useWatchlistStore } from "../../stores/watchlist";
import type { HeatmapSettings } from "./settings";
import { createSerialQueue, projectBoardThemes, snapshotVisualThemes, themesFromBoard } from "./themeInlineEdit";

export type SaveIndicatorState = "idle" | "saving" | "saved" | "error";

interface UndoEntry {
  id: number;
  prevThemes: HeatmapTheme[];
  prevSettings: HeatmapSettings;
  undoTransform: (themes: HeatmapTheme[]) => HeatmapTheme[];
  used: boolean;
  listeners: Set<() => void>;
}

export interface InlineEditActions {
  saveState: SaveIndicatorState;
  justCreatedId: string | null;
  clearJustCreated(): void;
  create(name: string): { ok: true; id: string } | { ok: false; problem: string };
  rename(id: string, name: string): { ok: true } | { ok: false; problem: string };
  removeTheme(id: string): void;
  reorderTheme(fromId: string, targetId: string, after: boolean): void;
  reorderSymbol(themeId: string, code: SymbolCode, targetCode: SymbolCode, after: boolean): void;
  transferStock(fromId: string, toId: string, code: SymbolCode, options?: { copy?: boolean; targetCode?: SymbolCode; after?: boolean }): void;
  addSymbol(themeId: string, code: SymbolCode, symbolName: string): void;
  removeSymbol(themeId: string, code: SymbolCode, symbolName: string): void;
  importFromWatchlist(listId: string): string[];
}

const MAX_UNDO_HISTORY = 30;
const SAVED_IDLE_DELAY_MS = 1800;

const failureText = (error: unknown) =>
  `테마를 저장하지 못했습니다: ${error instanceof ApiRequestError ? error.message : "알 수 없는 오류가 났습니다"}`;

function toast(text: string, undo?: ToastUndo, tone?: "info" | "warning" | "error") {
  useSelectionStore.getState().showToast(text, tone ? { tone, undo } : undo);
}

function makeToastUndo(entry: UndoEntry, runUndo: (entry: UndoEntry) => void): ToastUndo {
  return {
    available: () => !entry.used,
    run: () => runUndo(entry),
    subscribe: (listener) => {
      entry.listeners.add(listener);
      return () => void entry.listeners.delete(listener);
    },
  };
}

function markUsed(entry: UndoEntry) {
  if (entry.used) return;
  entry.used = true;
  entry.listeners.forEach((listener) => listener());
}

export function useHeatmapInlineEdit(
  boardData: HeatmapBoard | undefined,
  settings: HeatmapSettings,
  onChangeSettings: (next: HeatmapSettings) => void,
  names: ReadonlyMap<SymbolCode, string>,
) {
  const client = useQueryClient();
  const [optimisticThemes, setOptimisticThemes] = useState<HeatmapTheme[] | null>(null);
  const [extraNames, setExtraNames] = useState<ReadonlyMap<SymbolCode, string>>(() => new Map());
  const [saveState, setSaveState] = useState<SaveIndicatorState>("idle");
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);

  const enqueueRef = useRef<ReturnType<typeof createSerialQueue> | null>(null);
  if (enqueueRef.current === null) enqueueRef.current = createSerialQueue();
  const pendingRef = useRef(0);
  const optimisticRef = useRef<HeatmapTheme[] | null>(null);
  const undoStackRef = useRef<UndoEntry[]>([]);
  const undoSeqRef = useRef(0);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
  }, []);

  const liveRateOf = useCallback((code: SymbolCode) => quoteBook.get(code).quote?.changeRate ?? null, []);

  const displayBoard = useMemo(() => {
    if (!boardData) return undefined;
    if (optimisticThemes === null) return boardData;
    return projectBoardThemes(boardData, optimisticThemes, settings.order, liveRateOf, extraNames);
  }, [boardData, optimisticThemes, settings.order, liveRateOf, extraNames]);

  const currentThemes = useCallback((): HeatmapTheme[] => {
    if (optimisticRef.current !== null) return optimisticRef.current;
    return boardData ? themesFromBoard(boardData) : [];
  }, [boardData]);

  const finishJob = useCallback((failed: boolean) => {
    pendingRef.current = Math.max(0, pendingRef.current - 1);
    if (pendingRef.current > 0) return;
    optimisticRef.current = null;
    setOptimisticThemes(null);
    if (failed) {
      setSaveState("error");
      return;
    }
    setSaveState("saved");
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => {
      savedTimerRef.current = null;
      setSaveState((state) => (state === "saved" ? "idle" : state));
    }, SAVED_IDLE_DELAY_MS);
  }, []);

  const runUndoEntry = useCallback((entry: UndoEntry) => {
    if (entry.used) return;
    markUsed(entry);
    undoStackRef.current = undoStackRef.current.filter((item) => item.id !== entry.id);
    optimisticRef.current = entry.prevThemes;
    setOptimisticThemes(entry.prevThemes);
    if (entry.prevSettings.order !== settings.order || entry.prevSettings.sort !== settings.sort) {
      onChangeSettings(entry.prevSettings);
    }
    pendingRef.current += 1;
    setSaveState("saving");
    void enqueueRef.current!(async () => {
      try {
        await changeThemesNow(client, (latest) => ({ themes: entry.undoTransform(latest), result: undefined }));
        finishJob(false);
        toast("이전 상태로 되돌렸습니다");
      } catch (error) {
        finishJob(true);
        toast(failureText(error), undefined, "error");
      }
    });
  }, [client, finishJob, onChangeSettings, settings.order, settings.sort]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.shiftKey || event.altKey) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.code !== "KeyZ" && event.key.toLowerCase() !== "z") return;
      if (isTypingTarget(event.target)) return;
      const top = undoStackRef.current.at(-1);
      if (!top) return;
      event.preventDefault();
      event.stopPropagation();
      runUndoEntry(top);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [runUndoEntry]);

  const commit = useCallback((spec: {
    nextThemes: HeatmapTheme[];
    transform: (latest: HeatmapTheme[]) => HeatmapTheme[];
    undoTransform: (latest: HeatmapTheme[]) => HeatmapTheme[];
    message?: string;
    nextSettings?: HeatmapSettings;
  }) => {
    const prevThemes = currentThemes();
    const prevSettings = settings;
    const entry: UndoEntry = {
      id: ++undoSeqRef.current,
      prevThemes,
      prevSettings,
      undoTransform: spec.undoTransform,
      used: false,
      listeners: new Set(),
    };
    undoStackRef.current = [...undoStackRef.current.slice(-(MAX_UNDO_HISTORY - 1)), entry];
    optimisticRef.current = spec.nextThemes;
    setOptimisticThemes(spec.nextThemes);
    if (spec.nextSettings) onChangeSettings(spec.nextSettings);
    if (savedTimerRef.current !== null) {
      window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    pendingRef.current += 1;
    setSaveState("saving");
    const undo = makeToastUndo(entry, runUndoEntry);
    if (spec.message) toast(spec.message, undo);

    void enqueueRef.current!(async () => {
      try {
        await changeThemesNow(client, (latest) => ({ themes: spec.transform(latest), result: undefined }));
        finishJob(false);
      } catch (error) {
        markUsed(entry);
        undoStackRef.current = undoStackRef.current.filter((item) => item.id !== entry.id);
        if (spec.nextSettings) onChangeSettings(prevSettings);
        finishJob(true);
        toast(failureText(error), undefined, "error");
      }
    });
  }, [client, currentThemes, finishJob, onChangeSettings, runUndoEntry, settings]);

  const create = useCallback((rawName: string): { ok: true; id: string } | { ok: false; problem: string } => {
    const name = rawName.trim();
    const id = crypto.randomUUID();
    const result = createTheme(currentThemes(), id, name);
    if (!result.ok) return { ok: false, problem: result.problem };
    setJustCreatedId(id);
    commit({
      nextThemes: result.themes,
      transform: (latest) => {
        const applied = createTheme(latest, id, name);
        return applied.ok ? applied.themes : latest;
      },
      undoTransform: (latest) => deleteTheme(latest, id),
      message: `‘${name}’ 테마를 추가했습니다`,
    });
    return { ok: true, id };
  }, [commit, currentThemes]);

  const rename = useCallback((id: string, rawName: string): { ok: true } | { ok: false; problem: string } => {
    const name = rawName.trim();
    const themes = currentThemes();
    const target = themes.find((theme) => theme.id === id);
    if (!target || target.name === name) return { ok: true };
    const result = renameTheme(themes, id, name);
    if (!result.ok) {
      toast(result.problem, undefined, "warning");
      return { ok: false, problem: result.problem };
    }
    const oldName = target.name;
    commit({
      nextThemes: result.themes,
      transform: (latest) => {
        const applied = renameTheme(latest, id, name);
        return applied.ok ? applied.themes : latest;
      },
      undoTransform: (latest) => {
        const reverted = renameTheme(latest, id, oldName);
        return reverted.ok ? reverted.themes : latest;
      },
      message: `테마 이름을 바꿨습니다: ${oldName} → ${name}`,
    });
    return { ok: true };
  }, [commit, currentThemes]);

  const removeTheme = useCallback((id: string) => {
    const themes = currentThemes();
    const index = themes.findIndex((theme) => theme.id === id);
    if (index < 0) return;
    const removed = themes[index]!;
    let storedIndex = index;
    commit({
      nextThemes: deleteTheme(themes, id),
      transform: (latest) => {
        const found = latest.findIndex((theme) => theme.id === id);
        if (found >= 0) storedIndex = found;
        return deleteTheme(latest, id);
      },
      undoTransform: (latest) => {
        if (latest.some((theme) => theme.id === removed.id)) return latest;
        const insertAt = Math.min(storedIndex, latest.length);
        return [...latest.slice(0, insertAt), removed, ...latest.slice(insertAt)];
      },
      message: `‘${removed.name}’ 테마를 지웠습니다`,
    });
  }, [commit, currentThemes]);

  const reorderTheme = useCallback((fromId: string, targetId: string, after: boolean) => {
    if (fromId === targetId) return;
    const visual = displayBoard ? themesFromBoard(displayBoard) : currentThemes();
    const switchingOrder = settings.order !== "custom";
    const base = switchingOrder ? visual : currentThemes();
    const fromIndex = base.findIndex((theme) => theme.id === fromId);
    const targetIndex = base.findIndex((theme) => theme.id === targetId);
    if (fromIndex < 0 || targetIndex < 0) return;
    const slot = targetIndex + (after ? 1 : 0);
    const toIndex = slot > fromIndex ? slot - 1 : slot;
    if (fromIndex === toIndex) return;
    const nextThemes = moveItem(base, fromIndex, toIndex);
    const orderedIds = nextThemes.map((theme) => theme.id);
    commit({
      nextThemes,
      transform: (latest) => {
        if (!switchingOrder) {
          const curFrom = latest.findIndex((theme) => theme.id === fromId);
          const curTarget = latest.findIndex((theme) => theme.id === targetId);
          if (curFrom < 0 || curTarget < 0) return latest;
          const curSlot = curTarget + (after ? 1 : 0);
          return moveItem(latest, curFrom, curSlot > curFrom ? curSlot - 1 : curSlot);
        }
        const byId = new Map(latest.map((theme) => [theme.id, theme] as const));
        const head = orderedIds.flatMap((id) => {
          const found = byId.get(id);
          if (found) byId.delete(id);
          return found ? [found] : [];
        });
        return [...head, ...byId.values()];
      },
      undoTransform: () => base,
      nextSettings: switchingOrder ? { ...settings, order: "custom" } : undefined,
      message: switchingOrder ? "테마 순서를 '내 순서'로 전환하고 위치를 옮겼습니다" : "테마 위치를 옮겼습니다",
    });
  }, [commit, currentThemes, displayBoard, settings]);

  const reorderSymbol = useCallback((themeId: string, code: SymbolCode, targetCode: SymbolCode, after: boolean) => {
    if (code === targetCode) return;
    const switchingSort = settings.sort !== "custom";
    const base = switchingSort && displayBoard
      ? snapshotVisualThemes(displayBoard.themes, settings.sort, names)
      : currentThemes();
    const targetTheme = base.find((theme) => theme.id === themeId);
    if (!targetTheme) return;
    const fromIndex = targetTheme.symbols.indexOf(code);
    const targetIndex = targetTheme.symbols.indexOf(targetCode);
    if (fromIndex < 0 || targetIndex < 0) return;
    const slot = targetIndex + (after ? 1 : 0);
    const toIndex = slot > fromIndex ? slot - 1 : slot;
    if (fromIndex === toIndex) return;
    const nextThemes = moveSymbol(base, themeId, fromIndex, toIndex);
    const orderedSymbolsByTheme = new Map(nextThemes.map((theme) => [theme.id, theme.symbols] as const));
    const stockName = names.get(code) ?? extraNames.get(code) ?? code;
    commit({
      nextThemes,
      transform: (latest) => {
        if (!switchingSort) {
          const latestTheme = latest.find((theme) => theme.id === themeId);
          if (!latestTheme) return latest;
          const curFrom = latestTheme.symbols.indexOf(code);
          const curTarget = latestTheme.symbols.indexOf(targetCode);
          if (curFrom < 0 || curTarget < 0) return latest;
          const curSlot = curTarget + (after ? 1 : 0);
          return moveSymbol(latest, themeId, curFrom, curSlot > curFrom ? curSlot - 1 : curSlot);
        }
        return latest.map((theme) => {
          const desired = orderedSymbolsByTheme.get(theme.id);
          if (!desired) return theme;
          const held = new Set(theme.symbols);
          const head = desired.filter((symbol) => held.delete(symbol));
          return { ...theme, symbols: [...head, ...held] };
        });
      },
      undoTransform: () => base,
      nextSettings: switchingSort ? { ...settings, sort: "custom" } : undefined,
      message: switchingSort ? "종목 정렬을 '내 순서'로 전환하고 순서를 바꿨습니다" : `${stockName} 순서를 바꿨습니다`,
    });
  }, [commit, currentThemes, displayBoard, extraNames, names, settings]);

  const transferStock = useCallback((
    fromId: string,
    toId: string,
    code: SymbolCode,
    options?: { copy?: boolean; targetCode?: SymbolCode; after?: boolean },
  ) => {
    if (fromId === toId) return;
    const themes = currentThemes();
    const target = themes.find((theme) => theme.id === toId);
    const source = themes.find((theme) => theme.id === fromId);
    if (!source || !target) return;
    const sourceIndex = source.symbols.indexOf(code);
    const targetIndex = options?.targetCode && settings.sort === "custom"
      ? (() => {
        const idx = target.symbols.indexOf(options.targetCode);
        return idx >= 0 ? idx + (options.after ? 1 : 0) : undefined;
      })()
      : undefined;
    const copy = Boolean(options?.copy);
    const result = transferSymbol(themes, fromId, toId, code, { copy, toIndex: targetIndex });
    if (result.outcome === "duplicate") {
      toast(`‘${target.name}’ 테마에 이미 있는 종목입니다`, undefined, "warning");
      return;
    }
    if (result.outcome === "full") {
      toast(`‘${target.name}’ 테마는 종목이 ${MAX_THEME_SYMBOLS}개라 더 넣을 수 없습니다`, undefined, "warning");
      return;
    }
    if (result.outcome !== "added") return;
    const stockName = names.get(code) ?? extraNames.get(code) ?? code;
    commit({
      nextThemes: result.themes,
      transform: (latest) => {
        const latestTarget = latest.find((theme) => theme.id === toId);
        const latestToIndex = options?.targetCode && settings.sort === "custom" && latestTarget
          ? (() => {
            const idx = latestTarget.symbols.indexOf(options.targetCode);
            return idx >= 0 ? idx + (options.after ? 1 : 0) : undefined;
          })()
          : undefined;
        const applied = transferSymbol(latest, fromId, toId, code, { copy, toIndex: latestToIndex });
        return applied.outcome === "added" ? applied.themes : latest;
      },
      undoTransform: (latest) => {
        const withoutTarget = removeSymbolFromTheme(latest, toId, code);
        if (copy) return withoutTarget;
        return withoutTarget.map((theme) => {
          if (theme.id !== fromId || theme.symbols.includes(code)) return theme;
          const insertAt = sourceIndex >= 0 ? Math.min(sourceIndex, theme.symbols.length) : theme.symbols.length;
          return { ...theme, symbols: [...theme.symbols.slice(0, insertAt), code, ...theme.symbols.slice(insertAt)] };
        });
      },
      message: copy ? `${stockName} → ‘${target.name}’에 복제했습니다` : `${stockName} → ‘${target.name}’으로 옮겼습니다`,
    });
  }, [commit, currentThemes, extraNames, names, settings.sort]);

  const addSymbol = useCallback((themeId: string, code: SymbolCode, symbolName: string) => {
    const themes = currentThemes();
    const target = themes.find((theme) => theme.id === themeId);
    if (!target) return;
    const result = addSymbolToTheme(themes, themeId, code);
    if (result.outcome === "duplicate") {
      toast(`‘${target.name}’ 테마에 이미 있습니다: ${symbolName}`, undefined, "warning");
      return;
    }
    if (result.outcome === "full") {
      toast(`‘${target.name}’ 테마는 종목이 ${MAX_THEME_SYMBOLS}개라 더 넣을 수 없습니다`, undefined, "warning");
      return;
    }
    if (result.outcome === "index") {
      toast("지수는 테마에 담을 수 없습니다", undefined, "warning");
      return;
    }
    if (result.outcome !== "added") return;
    setExtraNames((current) => {
      if (current.get(code) === symbolName) return current;
      return new Map(current).set(code, symbolName);
    });
    commit({
      nextThemes: result.themes,
      transform: (latest) => {
        const applied = addSymbolToTheme(latest, themeId, code);
        return applied.outcome === "added" ? applied.themes : latest;
      },
      undoTransform: (latest) => removeSymbolFromTheme(latest, themeId, code),
      message: `‘${target.name}’ 테마에 추가했습니다: ${symbolName}`,
    });
  }, [commit, currentThemes]);

  const removeSymbol = useCallback((themeId: string, code: SymbolCode, symbolName: string) => {
    const themes = currentThemes();
    const target = themes.find((theme) => theme.id === themeId);
    if (!target) return;
    const removedIndex = target.symbols.indexOf(code);
    if (removedIndex < 0) return;
    commit({
      nextThemes: removeSymbolFromTheme(themes, themeId, code),
      transform: (latest) => removeSymbolFromTheme(latest, themeId, code),
      undoTransform: (latest) =>
        latest.map((theme) => {
          if (theme.id !== themeId || theme.symbols.includes(code) || theme.symbols.length >= MAX_THEME_SYMBOLS) return theme;
          const insertAt = Math.min(removedIndex, theme.symbols.length);
          return { ...theme, symbols: [...theme.symbols.slice(0, insertAt), code, ...theme.symbols.slice(insertAt)] };
        }),
      message: `‘${target.name}’ 테마에서 뺐습니다: ${symbolName}`,
    });
  }, [commit, currentThemes]);

  const importFromWatchlist = useCallback((listId: string): string[] => {
    const list = useWatchlistStore.getState().lists.find((candidate) => candidate.id === listId);
    if (!list) return [];
    const base = currentThemes();
    const generatedIds: string[] = [];
    const { themes, report } = importWatchlistGroups(base, list, () => {
      const id = crypto.randomUUID();
      generatedIds.push(id);
      return id;
    });
    const notices = importNotices(list.name, list.groups.length, report);
    if (report.imported.length === 0) {
      toast(notices[0] ?? "가져올 테마가 없습니다", undefined, "warning");
      return notices;
    }
    const addedSet = new Set(generatedIds);
    commit({
      nextThemes: themes,
      transform: (latest) => {
        let cursor = 0;
        return importWatchlistGroups(latest, list, () => generatedIds[cursor++] ?? crypto.randomUUID()).themes;
      },
      undoTransform: (latest) => latest.filter((theme) => !addedSet.has(theme.id)),
      message: notices[0],
    });
    return notices;
  }, [commit, currentThemes]);

  const clearJustCreated = useCallback(() => setJustCreatedId(null), []);

  const actions: InlineEditActions = useMemo(() => ({
    saveState,
    justCreatedId,
    clearJustCreated,
    create,
    rename,
    removeTheme,
    reorderTheme,
    reorderSymbol,
    transferStock,
    addSymbol,
    removeSymbol,
    importFromWatchlist,
  }), [
    saveState,
    justCreatedId,
    clearJustCreated,
    create,
    rename,
    removeTheme,
    reorderTheme,
    reorderSymbol,
    transferStock,
    addSymbol,
    removeSymbol,
    importFromWatchlist,
  ]);

  return { displayBoard, extraNames, actions };
}
