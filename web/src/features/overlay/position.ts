export type Placement = "bottom" | "top" | "right" | "left";
export interface Rect { left: number; top: number; right: number; bottom: number }
export function placeOverlay(anchor: Rect, box: { width: number; height: number }, viewport: { width: number; height: number }, preferred: Placement = "bottom", gap = 8) {
  const room = { bottom: viewport.height - anchor.bottom, top: anchor.top, right: viewport.width - anchor.right, left: anchor.left };
  const opposite = { bottom: "top", top: "bottom", right: "left", left: "right" } as const;
  const needed = (side: Placement) => (side === "top" || side === "bottom" ? box.height : box.width) + gap * 2;
  const flip = opposite[preferred];
  const side = room[preferred] < needed(preferred) && room[flip] > room[preferred] ? flip : preferred;
  const x = side === "right" ? anchor.right + gap : side === "left" ? anchor.left - box.width - gap : anchor.left;
  const y = side === "bottom" ? anchor.bottom + gap : side === "top" ? anchor.top - box.height - gap : anchor.top;
  return { left: Math.max(gap, Math.min(x, viewport.width - box.width - gap)), top: Math.max(gap, Math.min(y, viewport.height - box.height - gap)), side };
}
export function menuIndex(labels: readonly string[], current: number, key: string, query = ""): number {
  if (!labels.length) return -1;
  if (key === "Home") return 0;
  if (key === "End") return labels.length - 1;
  if (key === "ArrowDown") return (current + 1 + labels.length) % labels.length;
  if (key === "ArrowUp") return (current - 1 + labels.length) % labels.length;
  if (query) {
    for (let step = 1; step <= labels.length; step++) {
      const index = (current + step + labels.length) % labels.length;
      if (labels[index]?.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) return index;
    }
  }
  return current;
}
