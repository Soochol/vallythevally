import { flushSync } from "react-dom";
import { create } from "zustand";
import { useLayoutStore } from "../../stores/layout";
import { usePersistStore } from "../../stores/persist";
import { confirmAction } from "../overlay/Confirm";
import { layoutCommands, layoutNameProblem, showLayoutError, useLayoutsStore } from "./controller";

export type LayoutNaming = { kind: "naming"; operation: "saveAs" | "rename"; value: string; error: string | null };
type Surface = { kind: "closed" } | { kind: "menu" } | { kind: "confirming" } | LayoutNaming;
const LAYOUT_DELETE_EFFECT = "창 배치와 이 레이아웃에만 그린 드로잉이 함께 지워집니다. 되돌릴 수 없습니다";
type FocusRequest = { revision: number; target: "trigger" | "name" };

export const useLayoutMenuPresentation = create<{ surface: Surface; focus: FocusRequest | null }>()(() => ({ surface: { kind: "closed" }, focus: null }));

let focusRevision = 0;
function focus(surface: Surface, target: FocusRequest["target"]) {
  useLayoutMenuPresentation.setState({ surface, focus: { revision: ++focusRevision, target } });
}
function available() {
  return useLayoutsStore.getState().phase === "ready" && usePersistStore.getState().phase.kind === "ready";
}
function handoff() {
  flushSync(() => focus({ kind: "closed" }, "trigger"));
}
function close() {
  focus({ kind: "closed" }, "trigger");
}
function rejectName(naming: LayoutNaming, error: unknown) {
  focus({ ...naming, error: error instanceof Error ? error.message : String(error) }, "name");
}

export function acknowledgeLayoutMenuFocus(revision: number) {
  if (useLayoutMenuPresentation.getState().focus?.revision === revision) useLayoutMenuPresentation.setState({ focus: null });
}

export const layoutMenu = {
  async toggle() {
    const { surface } = useLayoutMenuPresentation.getState();
    if (surface.kind === "menu") { layoutMenu.dismissMenu(); return; }
    if (surface.kind !== "closed" || !available()) return;
    try {
      await layoutCommands.refresh();
      useLayoutMenuPresentation.setState({ surface: { kind: "menu" }, focus: null });
    } catch (error) { showLayoutError(error); close(); }
  },
  dismissMenu() {
    if (useLayoutMenuPresentation.getState().surface.kind === "menu") useLayoutMenuPresentation.setState({ surface: { kind: "closed" }, focus: null });
  },
  async select(id: string) {
    if (!available()) return;
    useLayoutMenuPresentation.setState({ surface: { kind: "closed" }, focus: null });
    try { await layoutCommands.open(id); }
    catch (error) { showLayoutError(error); }
    finally { close(); }
  },
  startNaming(operation: LayoutNaming["operation"]) {
    if (!available()) return;
    handoff();
    focus({ kind: "naming", operation, value: operation === "rename" ? useLayoutStore.getState().layout.name : `${useLayoutStore.getState().layout.name.slice(0, 17)} 사본`, error: null }, "name");
  },
  changeName(value: string) {
    const { surface } = useLayoutMenuPresentation.getState();
    if (surface.kind === "naming") useLayoutMenuPresentation.setState({ surface: { ...surface, value, error: null } });
  },
  closeNaming() {
    if (useLayoutMenuPresentation.getState().surface.kind === "naming" && useLayoutsStore.getState().phase === "ready") close();
  },
  async submitName() {
    const { surface } = useLayoutMenuPresentation.getState();
    if (surface.kind !== "naming" || !available()) return;
    const problem = layoutNameProblem(surface.value, useLayoutsStore.getState().layouts, surface.operation === "rename" ? useLayoutStore.getState().layout.id : undefined);
    if (problem) { rejectName(surface, problem); return; }
    try { await layoutCommands[surface.operation](surface.value); close(); }
    catch (error) { rejectName(surface, error); }
  },
  async confirmDelete() {
    if (!available()) return;
    const name = useLayoutStore.getState().layout.name;
    handoff();
    useLayoutMenuPresentation.setState({ surface: { kind: "confirming" }, focus: null });
    try {
      if (await confirmAction(`${name} 레이아웃을 지웁니다`, { action: "레이아웃 지우기", danger: true, detail: [LAYOUT_DELETE_EFFECT] })) await layoutCommands.delete();
    } catch (error) { showLayoutError(error); }
    finally { close(); }
  },
};
