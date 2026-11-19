import type { Rect } from "../overlay/position";

const LIST_MAX_WIDTH = 360;
const LIST_MARGIN = 8;

export const listWindowOf = (opener: HTMLElement | null) => opener?.closest(".od")?.getBoundingClientRect();

export const listWidthIn = (window: DOMRect) => Math.min(window.width - 2 * LIST_MARGIN, LIST_MAX_WIDTH);

export function listAnchorRect(opener: HTMLElement | null): Rect | undefined {
  const button = opener?.getBoundingClientRect();
  const window = listWindowOf(opener);
  if (!button || !window) return undefined;
  const left = Math.max(window.left + LIST_MARGIN, Math.min(button.left, window.right - LIST_MARGIN - listWidthIn(window)));
  return { left, right: left, top: button.top, bottom: button.bottom };
}
