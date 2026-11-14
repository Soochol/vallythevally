import type { QueryClient } from "@tanstack/react-query";
import { FIX_INVALID, type RunOutcome, type ScreenEditing } from "../screener/screenEditing";
import { screenEditingFor } from "../screener/useScreenEditing";
import { HOTKEYS } from "../../lib/hotkeys";
import { chartWindows, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import type { SearchCommand } from "../commands/registry";
import { openIndicatorCommand } from "../indicator-command/open";
import { pressScale } from "../indicator-dialog/compareForm";
import { saveSnapshot } from "../snapshot/saveSnapshot";

const RUN_TOAST: Partial<Record<RunOutcome["kind"], string>> = {
  invalid: FIX_INVALID,
  none: "조건식을 먼저 만들어 주세요",
  blocked: "자료 상태를 확인한 뒤 스크리너를 실행해 주세요",
};

export const screenerRunCommand = (editingOf: (client: QueryClient) => Pick<ScreenEditing, "run">): SearchCommand => ({
  id: "screener-run",
  label: "스크리너 실행",
  keywords: "조건식 검색 screener",
  shortcut: "Ctrl+Enter",
  run: async ({ queryClient }) => {
    const selection = useSelectionStore.getState();
    selection.setPhoneTab("screener");
    selection.showRightPanel("screener");
    const outcome = await editingOf(queryClient).run();
    const message = outcome.kind === "failed" ? outcome.message : RUN_TOAST[outcome.kind];
    if (message) selection.showToast(message);
  },
});

export const DEFAULT_SEARCH_COMMANDS: readonly SearchCommand[] = [
  ...HOTKEYS.flatMap(({ label, keys, action }): SearchCommand[] => {
    switch (action.kind) {
      case "indicators": return [{ id: "indicators", label, shortcut: keys, run: ({ cellId }) => openIndicatorCommand(cellId) }];
      case "toggleLog": return [{ id: "log", label, shortcut: keys, run: ({ cellId }) => {
        const layout = useLayoutStore.getState();
        const cell = chartWindows(layout.layout).find((c) => c.id === cellId);
        const next = cell && pressScale(cell.chartSettings, "log");
        if (next) layout.setScale(cellId, next);
      } }];
      case "toggleWatch": return [{ id: "watch-panel", label, shortcut: keys, run: () => useUiStore.getState().toggleWatch() }];
      case "snapshot": return [{ id: `snapshot-${action.mode}`, label, shortcut: keys, run: ({ cellId }) => saveSnapshot(cellId, action.mode) }];
      default: return [];
    }
  }),
  screenerRunCommand(screenEditingFor),
];
