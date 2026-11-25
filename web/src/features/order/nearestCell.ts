import type { OrderSide } from "../../api/generated/OrderSide";

export interface OrderCellRect {
  readonly side: OrderSide;
  readonly price: number;
  readonly rowKey: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface ResolvedOrderCell {
  readonly side: OrderSide;
  readonly price: number;
  readonly rowKey: string;
}

export const OUTER_EDGE_TOLERANCE_PX = 4;
export const INNER_EDGE_TOLERANCE_PX = 2;
export const VERTICAL_EDGE_TOLERANCE_PX = 4;

function horizontalDistance(x: number, rect: OrderCellRect): number {
  if (x >= rect.left && x <= rect.right) return 0;
  if (rect.side === "sell") {
    if (x < rect.left) return rect.left - x <= OUTER_EDGE_TOLERANCE_PX ? rect.left - x : Infinity;
    return x - rect.right <= INNER_EDGE_TOLERANCE_PX ? x - rect.right : Infinity;
  }
  if (x > rect.right) return x - rect.right <= OUTER_EDGE_TOLERANCE_PX ? x - rect.right : Infinity;
  return rect.left - x <= INNER_EDGE_TOLERANCE_PX ? rect.left - x : Infinity;
}

function verticalGap(y: number, rect: OrderCellRect): number {
  if (y >= rect.top && y <= rect.bottom) return 0;
  return y < rect.top ? rect.top - y : y - rect.bottom;
}

export function findNearestOrderCell(cells: readonly OrderCellRect[], x: number, y: number): ResolvedOrderCell | null {
  let best: OrderCellRect | null = null;
  let bestGap = Infinity;
  let bestCenter = Infinity;
  let bestDx = Infinity;
  for (const cell of cells) {
    const dx = horizontalDistance(x, cell);
    if (!Number.isFinite(dx)) continue;
    const dy = verticalGap(y, cell);
    if (dy > VERTICAL_EDGE_TOLERANCE_PX) continue;
    const center = Math.abs(y - (cell.top + cell.bottom) / 2);
    if (
      best === null
      || dy < bestGap
      || (dy === bestGap && center < bestCenter)
      || (dy === bestGap && center === bestCenter && dx < bestDx)
    ) {
      best = cell;
      bestGap = dy;
      bestCenter = center;
      bestDx = dx;
    }
  }
  return best === null ? null : { side: best.side, price: best.price, rowKey: best.rowKey };
}

export function cellFromElement(element: Element | null): ResolvedOrderCell | null {
  const cell = element?.closest<HTMLElement>("[data-order-cell]");
  if (!cell || cell.dataset.price === undefined || cell.dataset.rowKey === undefined) return null;
  return { side: cell.dataset.side as OrderSide, price: Number(cell.dataset.price), rowKey: cell.dataset.rowKey };
}

export function resolveOrderCellAt(container: HTMLElement, x: number, y: number, target?: EventTarget | null): ResolvedOrderCell | null {
  const element = target instanceof Element ? target : document.elementFromPoint(x, y);
  if (element?.closest(".od-colhead, [data-empty]")) return null;
  const direct = cellFromElement(element);
  if (direct !== null) return direct;
  const rects: OrderCellRect[] = [];
  for (const node of container.querySelectorAll<HTMLElement>("[data-order-cell]")) {
    if (node.dataset.price === undefined || node.dataset.rowKey === undefined) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    rects.push({
      side: node.dataset.side as OrderSide,
      price: Number(node.dataset.price),
      rowKey: node.dataset.rowKey,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    });
  }
  return findNearestOrderCell(rects, x, y);
}
