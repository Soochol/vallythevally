import type { LayoutWindow } from "../api/generated/LayoutWindow";
import { isIndexCode } from "../lib/symbol";
import type { WindowState } from "../stores/layout";

export function toWireWindow(w: WindowState): LayoutWindow {
  if (w.kind !== "chart") return w;
  return { ...w, venue: isIndexCode(w.symbol) ? null : "combined" };
}
