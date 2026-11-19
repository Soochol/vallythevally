import { ownsChartKeyboard } from "./overlay/topLayer";
import { useEffect } from "react";
import { matchHotkey } from "../lib/hotkeys";
import { isTypingTarget } from "../lib/typingTarget";
import { DESKTOP_QUERY } from "../lib/media";
import { openIndicatorCommand } from "./indicator-command/open";
import { PERIODS } from "../lib/symbol";
import { chartWindows, useLayoutStore } from "../stores/layout";
import { useSelectionStore } from "../stores/selection";
import { pressScale } from "./indicator-dialog/compareForm";
import { jumpToBar } from "./jump/jumpToBar";
import { saveSnapshot } from "./snapshot/saveSnapshot";
import { openSystemSettings } from "./system-settings/open";
import { wizardVisible, useWizardStore } from "./setup-wizard/wizardOpen";
import { useAccountStore } from "../stores/account";
import { currentActionKeys } from "../stores/ui";

/** 화면 전체의 단축키. 대화상자가 열려 있거나 입력칸에 초점이 있으면 쓰지 않는다. */
export function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || ownsChartKeyboard(e)) return;
      if (wizardVisible(useAccountStore.getState().status, useWizardStore.getState().open)) return;
      const sel = useSelectionStore.getState();
      if (sel.dialog) {
        if (e.key === "Escape") sel.closeDialog();
        return;
      }
      if (isTypingTarget(e.target)) return;
      const action = matchHotkey(e, matchMedia(DESKTOP_QUERY).matches ? "desktop" : "phone", currentActionKeys());
      if (!action) return;
      e.preventDefault();
      if (action.kind === "systemSettings") return openSystemSettings();
      const layout = useLayoutStore.getState();
      const cellId = sel.activeCell;
      const cell = chartWindows(layout.layout).find((c) => c.id === cellId);
      if (!cell) return;
      switch (action.kind) {
        case "search":
          return sel.openSearch();
        case "indicators":
          return openIndicatorCommand(cellId);
        case "showWatchlist":
          return layout.showWindow("watchlist");
        case "period":
          return layout.setPeriod(cellId, action.period);
        case "periodStep": {
          const i = PERIODS.indexOf(cell.period);
          const next = PERIODS[Math.min(PERIODS.length - 1, Math.max(0, i + action.step))];
          return next && layout.setPeriod(cellId, next);
        }
        case "snapshot":
          return saveSnapshot(cellId, action.mode);
        case "jump":
          return void jumpToBar(cellId);
        case "toggleLog": {
          const next = pressScale(cell.chartSettings, "log");
          return next && layout.setScale(cellId, next);
        }
        default: {
          const _exhaustive: never = action;
          return _exhaustive;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
