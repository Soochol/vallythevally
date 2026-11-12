import { screensQuery, screenerStatusQuery } from "../../api/screener";
import { HOTKEYS } from "../../lib/hotkeys";
import { runBlock } from "../../lib/screener";
import { useLayoutStore } from "../../stores/layout";
import { useScreenerStore } from "../../stores/screener";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import type { SearchCommand } from "../commands/registry";
import { pressScale } from "../indicator-dialog/compareForm";
import { saveSnapshot } from "../snapshot/saveSnapshot";

export const DEFAULT_SEARCH_COMMANDS: readonly SearchCommand[] = [
  ...HOTKEYS.flatMap(({ label, keys, action }): SearchCommand[] => {
    switch (action.kind) {
      case "indicators": return [{ id: "indicators", label, shortcut: keys, run: ({ slot }) => useSelectionStore.getState().openIndicators(slot) }];
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
    selection.setDesktopView("screener");
    selection.setPhoneTab("screener");
    selection.showRightPanel("screener");
    const [screens, status] = await Promise.all([
      queryClient.fetchQuery(screensQuery),
      queryClient.fetchQuery({ ...screenerStatusQuery(1000), staleTime: 0 }),
    ]);
    const store = useScreenerStore.getState();
    const screen = screens.screens.find((s) => s.id === store.chosenId) ?? screens.screens[0];
    if (!screen) return selection.showToast("조건식을 먼저 만들어 주세요");
    if (runBlock(status)) return selection.showToast("자료 상태를 확인한 뒤 스크리너를 실행해 주세요");
    if (store.runs[screen.id]?.kind === "running") return;
    await store.run(screen);
    await queryClient.invalidateQueries({ queryKey: ["screener", "status"] });
  } },
];
