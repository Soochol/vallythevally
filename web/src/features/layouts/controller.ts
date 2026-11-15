import { flushSync } from "react-dom";
import { create } from "zustand";
import type { Layout } from "../../api/generated/Layout";
import type { LayoutInput } from "../../api/generated/LayoutInput";
import type { LayoutSummary } from "../../api/generated/LayoutSummary";
import { ApiRequestError, deleteJson, putJson } from "../../api/http";
import { fetchSymbolInfo } from "../../api/queries";
import { fetchLayout, fetchLayouts, layoutPath } from "../../api/userData";
import { defaultDock } from "../../layout/dock/fit";
import { layoutAutosave } from "../../persist/autosave";
import { restoreLayout, type RestoredLayout } from "../../persist/restore";
import { clearUnsaved, readUnsaved } from "../../persist/unsaved";
import { useDrawingSession } from "../../stores/drawingSession";
import { useLayoutStore, chartWindows, windowRefs } from "../../stores/layout";
import { usePersistStore } from "../../stores/persist";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { useIndicatorPreview } from "../indicator-command/preview";

interface LayoutMenuState {
  phase: "ready" | "busy";
  layouts: LayoutSummary[];
}

export const useLayoutsStore = create<LayoutMenuState>()(() => ({ phase: "ready", layouts: [] }));

export function layoutNameProblem(input: string, layouts: readonly LayoutSummary[], ownId?: string): string | null {
  const name = input.trim();
  if ([...name].length < 1 || [...name].length > 20) return "레이아웃 이름은 앞뒤 공백을 빼고 1~20자여야 합니다";
  if (layouts.some((layout) => layout.id !== ownId && layout.name === name)) return "같은 이름의 레이아웃이 있습니다";
  return null;
}

export const showLayoutError = (error: unknown) => useSelectionStore.getState().showToast(error instanceof Error ? error.message : String(error));

function install(next: RestoredLayout) {
  const autosave = layoutAutosave();
  flushSync(() => usePersistStore.getState().setPhase({ kind: "restoring" }));
  useSelectionStore.setState({ activeCell: chartWindows(next.layout)[0]!.id, dialog: null, inspector: null, toast: null });
  useDrawingSession.setState({ selected: [], editor: null, popup: null, toolbarAt: null });
  useIndicatorPreview.setState({ current: null });
  useLayoutStore.getState().load(next.layout);
  autosave.replaceLayout(next.layout, next.revision, next.serverCharts);
  clearUnsaved("layout", next.serverRevision, layoutPath(next.layout.id));
  useUiStore.getState().setLastLayoutId(next.layout.id);
  if (next.dirty) autosave.savers.layout.changed();
  usePersistStore.getState().setPhase({ kind: "ready" });
  next.notices.forEach((text) => useSelectionStore.getState().showToast(text));
}

export interface LayoutCommandsDeps {
  list: typeof fetchLayouts;
  get: typeof fetchLayout;
  put(layout: LayoutInput): Promise<Layout>;
  delete(id: string): Promise<void>;
  restore(stored: Layout): Promise<RestoredLayout>;
  install(next: RestoredLayout): void;
  uuid(): string;
}

export function createLayoutCommands(deps: LayoutCommandsDeps) {
  let pendingDelete: { id: string; next: RestoredLayout; resume(): void } | null = null;
  const refresh = async () => {
    const layouts = await deps.list();
    useLayoutsStore.setState({ layouts });
    return layouts;
  };
  const afterMutation = async () => {
    try { await refresh(); }
    catch (error) { showLayoutError(`레이아웃 변경은 저장했지만 목록을 새로 읽지 못했습니다. ${error instanceof Error ? error.message : String(error)}`); }
  };
  const finishDeletion = async (pending: NonNullable<typeof pendingDelete>) => {
    pendingDelete = null;
    clearUnsaved("layout", Number.MAX_SAFE_INTEGER, layoutPath(pending.id));
    deps.install(pending.next);
    await afterMutation();
  };
  const reconcileDeletion = async () => {
    const pending = pendingDelete;
    if (!pending) return false;
    try { await deps.get(pending.id); }
    catch (error) {
      if (error instanceof ApiRequestError && error.code === "not_found") {
        await finishDeletion(pending);
        return true;
      }
      throw new Error(`레이아웃 지우기 결과를 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요. ${error instanceof Error ? error.message : String(error)}`);
    }
    pendingDelete = null;
    pending.resume();
    return false;
  };
  const run = async (work: () => Promise<void>) => {
    if (useLayoutsStore.getState().phase !== "ready" || usePersistStore.getState().phase.kind !== "ready") return;
    const previousId = useLayoutStore.getState().layout.id;
    const fromMenu = typeof document !== "undefined" && Boolean(document.activeElement?.closest('[role="menu"][aria-label="레이아웃"]'));
    useLayoutsStore.setState({ phase: "busy" });
    try {
      if (pendingDelete && await reconcileDeletion()) return;
      await work();
    } finally {
      if (typeof document !== "undefined" && (fromMenu || previousId !== useLayoutStore.getState().layout.id)) {
        flushSync(() => useLayoutsStore.setState({ phase: "ready" }));
        document.querySelector<HTMLButtonElement>("[data-layout-trigger]")?.focus();
      } else useLayoutsStore.setState({ phase: "ready" });
    }
  };
  const name = (input: string, ownId?: string) => {
    const problem = layoutNameProblem(input, useLayoutsStore.getState().layouts, ownId);
    if (problem) throw new Error(problem);
    return input.trim();
  };
  return {
    refresh: () => run(async () => { await refresh(); }),
    open: (id: string) => run(async () => {
      if (useLayoutStore.getState().layout.id === id) return;
      const saver = layoutAutosave().savers.layout;
      await saver.save();
      const next = await deps.restore(await deps.get(id));
      await saver.saveAndSuspend();
      deps.install(next);
    }),
    saveAs: (input: string) => run(async () => {
      const nextName = name(input);
      const saver = layoutAutosave().savers.layout;
      await saver.save();
      const snapshot = useLayoutStore.getState().layout;
      const saved = await deps.put({ ...snapshot, id: deps.uuid(), name: nextName, revision: Date.now() });
      try {
        const next = await deps.restore(saved);
        await saver.saveAndSuspend();
        deps.install(next);
      } finally { await afterMutation(); }
    }),
    rename: (input: string) => run(async () => {
      const nextName = name(input, useLayoutStore.getState().layout.id);
      const saver = layoutAutosave().savers.layout;
      await saver.saveAndSuspend();
      try {
        const snapshot = useLayoutStore.getState().layout;
        const latest = await deps.get(snapshot.id);
        const saved = await deps.put({ ...snapshot, name: nextName, revision: Math.max(Date.now(), latest.revision + 1) });
        saver.advanceRevision(saved.revision);
        useLayoutStore.getState().rename(nextName);
      } finally { saver.resume(); }
      await afterMutation();
    }),
    delete: () => run(async () => {
      const id = useLayoutStore.getState().layout.id;
      const layouts = await refresh();
      const first = layouts.find((layout) => layout.id !== id);
      if (!first) throw new Error("레이아웃은 하나 이상 있어야 합니다");
      const saver = layoutAutosave().savers.layout;
      await saver.save();
      const next = await deps.restore(await deps.get(first.id));
      await saver.saveAndSuspend();
      const pending = { id, next, resume: () => saver.resume() };
      pendingDelete = pending;
      try { await deps.delete(id); }
      catch (error) {
        if (await reconcileDeletion()) return;
        throw error;
      }
      await finishDeletion(pending);
    }),
    resetPlacement: () => {
      if (useLayoutsStore.getState().phase !== "ready") return;
      const { layout, arrange } = useLayoutStore.getState();
      arrange({ windows: layout.windows, placement: { ...layout.placement, dock: defaultDock(windowRefs(layout.windows)) } });
    },
  };
}

export const layoutCommands = createLayoutCommands({
  list: fetchLayouts, get: fetchLayout,
  put: (body) => putJson<Layout>(layoutPath(body.id), body),
  delete: (id) => deleteJson(layoutPath(id)),
  restore: (stored) => restoreLayout(stored, { symbolInfo: (code) => fetchSymbolInfo(code), unsaved: readUnsaved }),
  install, uuid: () => crypto.randomUUID(),
});
