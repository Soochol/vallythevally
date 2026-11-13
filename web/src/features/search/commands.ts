import { workspaceFor } from "../screener/useWorkspace";
import { screenerStatusQuery } from "../../api/screener";
import { HOTKEYS } from "../../lib/hotkeys";
import { runBlock } from "../../lib/screener";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import type { SearchCommand } from "../commands/registry";
import { pressScale } from "../indicator-dialog/compareForm";
import { saveSnapshot } from "../snapshot/saveSnapshot";

export const DEFAULT_SEARCH_COMMANDS: readonly SearchCommand[] = [
  ...HOTKEYS.flatMap(({ label, keys, action }): SearchCommand[] => {
    switch (action.kind) {
      case "indicators": return [{ id: "indicators", label, shortcut: keys, run: ({ slot }) => useSelectionStore.getState().openIndicatorCommand(slot) }];
      case "toggleLog": return [{ id: "log", label, shortcut: keys, run: ({ slot }) => {
        const layout = useLayoutStore.getState();
        const cell = layout.layout.cells.find((c) => c.slot === slot);
        const next = cell && pressScale(cell.chartSettings, "log");
        if (next) layout.setScale(slot, next);
      } }];
      case "toggleWatch": return [{ id: "watch-panel", label, shortcut: keys, run: () => useUiStore.getState().toggleWatch() }];
      case "snapshot": return [{ id: `snapshot-${action.mode}`, label, shortcut: keys, run: ({ slot }) => saveSnapshot(slot, action.mode) }];
      default: return [];
    }
  }),
  { id: "screener-run", label: "스크리너 실행", keywords: "조건식 검색 screener", shortcut: "Ctrl+Enter", run: async ({ queryClient }) => {
    const selection = useSelectionStore.getState();
    selection.setPhoneTab("screener");
    selection.showRightPanel("screener");
    const workspace = workspaceFor(queryClient);
    const [, status] = await Promise.all([
      workspace.load(),
      queryClient.fetchQuery({ ...screenerStatusQuery(1000), staleTime: 0 }),
    ]);
    const attempt = await workspace.run(runBlock(status) !== null);
    if (attempt === "invalid") return selection.showToast("조건식의 잘못된 값을 고쳐 주세요");
    if (attempt === "none") return selection.showToast("조건식을 먼저 만들어 주세요");
    if (attempt === "blocked") return selection.showToast("자료 상태를 확인한 뒤 스크리너를 실행해 주세요");
    if (attempt === "ran") await queryClient.invalidateQueries({ queryKey: ["screener", "status"] });
  } },
];
