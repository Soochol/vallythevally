import type { KeyLike } from "../../lib/hotkeys";
import type { DrawingTool } from "./types";

export const TOOL_HOTKEYS: readonly { tool: DrawingTool; code: string; shift: boolean; alt: boolean; keys: string }[] = [
  { tool: "trendline", code: "KeyT", shift: false, alt: false, keys: "T" },
  { tool: "trendline", code: "KeyT", shift: false, alt: true, keys: "Alt+T" },
  { tool: "hline", code: "KeyH", shift: false, alt: false, keys: "H" },
  { tool: "hline", code: "KeyH", shift: false, alt: true, keys: "Alt+H" },
  { tool: "hray", code: "KeyJ", shift: false, alt: true, keys: "Alt+J" },
  { tool: "vline", code: "KeyV", shift: true, alt: false, keys: "Shift+V" },
  { tool: "vline", code: "KeyV", shift: false, alt: true, keys: "Alt+V" },
  { tool: "rect", code: "KeyR", shift: false, alt: false, keys: "R" },
  { tool: "rect", code: "KeyR", shift: true, alt: true, keys: "Shift+Alt+R" },
  { tool: "fib", code: "KeyF", shift: false, alt: false, keys: "F" },
  { tool: "fib", code: "KeyF", shift: false, alt: true, keys: "Alt+F" },
  { tool: "text", code: "KeyX", shift: false, alt: false, keys: "X" },
];
export function toolHotkey(e: KeyLike) {
  return !e.ctrlKey && !e.metaKey ? TOOL_HOTKEYS.find((h) => h.code === e.code && h.alt === e.altKey && h.shift === e.shiftKey) : undefined;
}
