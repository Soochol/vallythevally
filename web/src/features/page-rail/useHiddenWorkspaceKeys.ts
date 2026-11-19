import { useEffect } from "react";
import { isTypingTarget } from "../../lib/typingTarget";
import { ownsChartKeyboard } from "../overlay/topLayer";

const OWNERS_OF_KEYS = "[role=dialog], [popover], [data-chart-escape-owner]";

function hiddenWorkspaceShouldIgnoreKey(event: Pick<KeyboardEvent, "key" | "target">): boolean {
  if (ownsChartKeyboard(event) || isTypingTarget(event.target)) return false;
  return !(event.target instanceof Element && event.target.closest(OWNERS_OF_KEYS) !== null);
}

export function useHiddenWorkspaceKeys(hidden: boolean) {
  useEffect(() => {
    const root = document.getElementById("root");
    if (!hidden || !root) return;
    const ignoreOutsideRoot = (event: KeyboardEvent) => {
      if (!(event.target instanceof Node && root.contains(event.target)) && hiddenWorkspaceShouldIgnoreKey(event)) event.stopPropagation();
    };
    const ignoreInsideRoot = (event: KeyboardEvent) => {
      if (hiddenWorkspaceShouldIgnoreKey(event)) event.stopPropagation();
    };
    window.addEventListener("keydown", ignoreOutsideRoot, true);
    root.addEventListener("keydown", ignoreInsideRoot);
    return () => {
      window.removeEventListener("keydown", ignoreOutsideRoot, true);
      root.removeEventListener("keydown", ignoreInsideRoot);
    };
  }, [hidden]);
}
