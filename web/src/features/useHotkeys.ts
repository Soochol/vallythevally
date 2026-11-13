import { ownsChartKeyboard } from "./overlay/topLayer";
import { useEffect } from "react";
import { isTypingTarget, matchHotkey } from "../lib/hotkeys";
import { DESKTOP_QUERY } from "../lib/media";
import { openIndicatorCommand } from "./indicator-command/open";
import { PERIODS } from "../lib/symbol";
import { useLayoutStore } from "../stores/layout";
import { useSelectionStore } from "../stores/selection";
import { useUiStore } from "../stores/ui";
import { pressScale } from "./indicator-dialog/compareForm";
import { saveSnapshot } from "./snapshot/saveSnapshot";

/** 화면 전체의 단축키. 대화상자가 열려 있거나 입력칸에 초점이 있으면 쓰지 않는다. */
export function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || ownsChartKeyboard(e)) return;
      const sel = useSelectionStore.getState();
      if (sel.dialog) {
        if (e.key === "Escape") sel.closeDialog();
        return;
      }
      if (isTypingTarget(e.target)) return;
      const action = matchHotkey(e, matchMedia(DESKTOP_QUERY).matches ? "desktop" : "phone");
      if (!action) return;
      e.preventDefault();
      const layout = useLayoutStore.getState();
      const slot = sel.activeSlot;
      const cell = layout.layout.cells.find((c) => c.slot === slot);
      if (!cell) return;
      switch (action.kind) {
        case "search":
          return sel.openSearch();
        case "indicators":
          return openIndicatorCommand(slot);
        case "toggleWatch":
          return useUiStore.getState().toggleWatch();
        case "period":
          return layout.setPeriod(slot, action.period);
        case "periodStep": {
          const i = PERIODS.indexOf(cell.period);
          const next = PERIODS[Math.min(PERIODS.length - 1, Math.max(0, i + action.step))];
          return next && layout.setPeriod(slot, next);
        }
        case "snapshot":
          return saveSnapshot(slot, action.mode);
        case "toggleLog": {
          const next = pressScale(cell.chartSettings, "log");
          return next && layout.setScale(slot, next);
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
