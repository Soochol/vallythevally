import { useEffect } from "react";
import { isTypingTarget } from "../../lib/typingTarget";
import { ownsChartKeyboard } from "../overlay/topLayer";

const OWNERS_OF_KEYS = ".page-stage, .landing, [role=dialog], [popover], [data-chart-escape-owner]";

export function hiddenWorkspaceShouldIgnoreKey(event: Pick<KeyboardEvent, "key" | "target">): boolean {
  if (ownsChartKeyboard(event) || isTypingTarget(event.target)) return false;
  return !(event.target instanceof Element && event.target.closest(OWNERS_OF_KEYS) !== null);
}

export function useHiddenWorkspaceKeys(hidden: boolean) {
  useEffect(() => {
    if (!hidden) return;
    const ignore = (event: KeyboardEvent) => {
      if (hiddenWorkspaceShouldIgnoreKey(event)) event.stopPropagation();
    };
    window.addEventListener("keydown", ignore, true);
    return () => window.removeEventListener("keydown", ignore, true);
  }, [hidden]);
}
