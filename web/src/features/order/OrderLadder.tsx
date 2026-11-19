import { type ReactNode, type RefObject, useCallback, useLayoutEffect, useState } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import { formatPrice } from "../../lib/format";
import type { LadderRow } from "../market-window/ladder";
import { type LadderRowSlots, PriceLadder } from "../market-window/PriceLadder";
import { formatShares } from "../market-window/format";
import { groupKey, type PriceGroup, previewText, SIDE_LABEL } from "./orderRules";
import { PENDING_TEXT } from "./statusText";
import { LADDER_ROW_HEIGHT_PX, type RowRange, scrollTopToCenter, visibleRowRange } from "./priceRange";
import { OrderList, type OrderListItem } from "./OrderList";
import type { OrderDrag } from "./useOrderDrag";

export interface HoverCell {
  readonly side: OrderSide;
  readonly price: number;
}

export interface ExplorerScroll {
  readonly centerPrice: number | null;
  readonly centerToken: number;
}

export interface LadderActions {
  place(side: OrderSide, price: number): void;
  cancelOne(orderNo: string): void;
  cancelAtPrice(side: OrderSide, price: number): void;
  cancelGroups(groups: readonly PriceGroup[]): void;
}

interface Props {
  readonly rows: readonly LadderRow[];
  readonly previousClose: number | null;
  readonly groups: ReadonlyMap<string, PriceGroup>;
  readonly writable: boolean;
  readonly previewQuantity: number;
  readonly hover: HoverCell | null;
  readonly onHover: (cell: HoverCell | null) => void;
  readonly actions: LadderActions;
  readonly averagePrice: number | null;
  readonly divider: boolean;
  readonly explorer?: ExplorerScroll;
  readonly ladder: RefObject<HTMLDivElement | null>;
  readonly drag: OrderDrag;
  readonly rowSlots?: LadderRowSlots;
  readonly expectedPrice?: number | null;
}

type MenuState = { readonly x: number; readonly y: number; readonly group: PriceGroup | null };

const SIDE_OF_SLOT: Readonly<Record<"left" | "right", OrderSide>> = { left: "sell", right: "buy" };

export function OrderLadder({ rows, previousClose, groups, writable, previewQuantity, hover, onHover, actions, averagePrice, divider, explorer, ladder, drag, rowSlots, expectedPrice }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const { view, begin } = drag;

  const exploring = explorer !== undefined;
  const [range, setRange] = useState<RowRange>({ start: 0, end: 0 });
  const rowCount = rows.length;
  const centerPrice = explorer?.centerPrice ?? null;
  const centerToken = explorer?.centerToken;
  const centerIndex = centerPrice === null ? -1 : rows.findIndex((row) => row.price !== null && row.price <= centerPrice);

  const measureRange = useCallback(() => {
    const element = ladder.current;
    if (!element) return;
    const next = visibleRowRange(element.scrollTop, element.clientHeight, rowCount);
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [rowCount]);

  useLayoutEffect(() => {
    if (!exploring) return;
    measureRange();
    const element = ladder.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureRange);
    observer.observe(element);
    return () => observer.disconnect();
  }, [exploring, measureRange]);

  useLayoutEffect(() => {
    const element = ladder.current;
    if (!exploring || !element || centerIndex < 0) return;
    element.scrollTop = scrollTopToCenter(centerIndex, element.clientHeight);
    measureRange();
  }, [exploring, centerToken]);

  const cell = (slot: "left" | "right") => (row: LadderRow): ReactNode => {
    const side = SIDE_OF_SLOT[slot];
    const price = row.price;
    if (price === null) return <div className="od-cell" data-empty="" />;
    const group = groups.get(groupKey(side, price));
    const hovered = hover?.side === side && hover.price === price;
    return (
      <div
        className="od-cell"
        data-order-cell=""
        data-side={side}
        data-price={price}
        data-disabled={writable ? undefined : ""}
        data-target={view?.target.kind === "cell" && view.target.side === side && view.target.price === price ? "" : undefined}
        onDoubleClick={() => { if (writable && !group) actions.place(side, price); }}
        onPointerEnter={() => onHover({ side, price })}
        onPointerLeave={() => onHover(null)}
      >
        {group && !row.repeat
          ? <button type="button" className="od-chip" data-testid="order-chip" data-side={side} data-price={price} data-dragging={view?.source.kind === "chip" && view.source.group === group ? "" : undefined} data-pending={group.pending}
              aria-label={`${SIDE_LABEL[side]} ${formatPrice(price, false)}원 ${formatShares(group.quantity)} 주문${group.pending ? ` ${PENDING_TEXT[group.pending]}` : ""}`}
              onPointerDown={(e) => { if (writable && !group.pending) begin({ source: { kind: "chip", group }, origin: null }, e); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (!group.pending) setMenu({ x: e.clientX, y: e.clientY, group }); }}>
              {group.quantity.toLocaleString("ko-KR")}
            </button>
          : hovered && writable && previewQuantity > 0 && <span className="od-preview">{previewText(side, previewQuantity)}</span>}
      </div>
    );
  };
  const slots = { left: cell("left"), right: cell("right") };

  const all = [...groups.values()];
  const items = (state: MenuState): OrderListItem[] => {
    const { group } = state;
    if (group) {
      return [
        { kind: "heading", label: `${formatPrice(group.price, false)}원 ${SIDE_LABEL[group.side]} 주문` },
        ...group.orders.map((order): OrderListItem => ({ kind: "order", label: `${order.openQuantity.toLocaleString("ko-KR")} 취소`, order, disabled: !writable, onSelect: () => actions.cancelOne(order.orderNo) })),
        { kind: "separator" },
        { kind: "action", label: "이 가격 모두 취소", danger: true, disabled: !writable, onSelect: () => actions.cancelAtPrice(group.side, group.price) },
      ];
    }
    const side = (s: OrderSide) => all.filter((g) => g.side === s);
    const entry = (label: string, targets: readonly PriceGroup[]): OrderListItem => ({ kind: "action", label, danger: true, disabled: !writable || targets.length === 0, onSelect: () => actions.cancelGroups(targets) });
    return [entry("매수 모두 취소", side("buy")), entry("매도 모두 취소", side("sell")), entry("전체 모두 취소", all)];
  };

  const shown = exploring ? rows.slice(range.start, range.end) : rows;
  const ladderView = <PriceLadder rows={shown} previousClose={previousClose} slots={slots} rowSlots={exploring ? undefined : rowSlots} mark={{ price: averagePrice, label: "평단가" }} expectedPrice={expectedPrice} firstBidIndex={exploring ? Math.max(0, (centerIndex < 0 ? rowCount : centerIndex) - range.start) : undefined} />;

  return (
    <div ref={ladder} className="od-ladder" data-testid="order-ladder" data-explorer={exploring ? "" : undefined} data-dragging={view ? "" : undefined} data-divider={divider ? "" : undefined}
      onScroll={exploring ? measureRange : undefined}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, group: null }); }}>
      {exploring
        ? <div className="od-explorer-rows" data-testid="order-explorer-rows" style={{ paddingTop: range.start * LADDER_ROW_HEIGHT_PX, paddingBottom: (rowCount - range.end) * LADDER_ROW_HEIGHT_PX }}>{ladderView}</div>
        : ladderView}
      {menu && <OrderList label={menu.group ? "주문 목록" : "주문 취소"} root={ladder} point={{ x: menu.x, y: menu.y }} drag={drag} items={items(menu)} onClose={() => setMenu(null)} />}
    </div>
  );
}
