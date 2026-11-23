import { memo, type ReactNode, type RefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import { formatPrice } from "../../lib/format";
import { useStoreValue, type ValueStore } from "../../lib/valueStore";
import type { LadderRow } from "../market-window/ladder";
import { ladderColumns, type LadderRowSlots, PriceLadder } from "../market-window/PriceLadder";
import { formatShares } from "../market-window/format";
import { addQuantityText, type BuyingPower, buyPreview, groupKey, type PriceGroup, previewText, SIDE_LABEL } from "./orderRules";
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
  readonly buying: BuyingPower | null;
  readonly hover: ValueStore<HoverCell | null>;
  readonly actions: LadderActions;
  readonly averagePrice: number | null;
  readonly divider: boolean;
  readonly explorer?: ExplorerScroll;
  readonly currentToken: number;
  readonly ladder: RefObject<HTMLDivElement | null>;
  readonly drag: OrderDrag;
  readonly rowSlots?: LadderRowSlots;
  readonly expectedPrice?: number | null;
}

type MenuState = { readonly x: number; readonly y: number; readonly group: PriceGroup | null };

const SIDE_OF_SLOT: Readonly<Record<"left" | "right", OrderSide>> = { left: "sell", right: "buy" };

interface CellApi {
  readonly hover: ValueStore<HoverCell | null>;
  readonly drag: OrderDrag;
  readonly actions: LadderActions;
  readonly openMenu: (menu: MenuState) => void;
}

interface CellProps {
  readonly side: OrderSide;
  readonly price: number;
  readonly group: PriceGroup | undefined;
  readonly writable: boolean;
  readonly previewQuantity: number;
  readonly buying: BuyingPower | null;
  readonly api: CellApi;
}

const COLUMN_NAMES = ["매도주문", "매도잔량", "호가", "매수잔량", "매수주문"] as const;
const HEAD_COLUMNS = ladderColumns(true, true);

const LadderHead = memo(function LadderHead() {
  return (
    <div className="od-colhead" data-testid="order-colhead" style={{ gridTemplateColumns: HEAD_COLUMNS }}>
      {COLUMN_NAMES.map((name) => <span key={name}>{name}</span>)}
    </div>
  );
});

const currentRowOffset = (element: HTMLElement): number | null => {
  const row = element.querySelector<HTMLElement>(".mw-lr[data-current]");
  if (row === null) return null;
  const head = element.querySelector<HTMLElement>(".od-colhead")?.offsetHeight ?? 0;
  const rowCenter = row.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop + row.offsetHeight / 2;
  return Math.max(0, rowCenter - head - (element.clientHeight - head) / 2);
};

const OrderCell = memo(function OrderCell({ side, price, group, writable, previewQuantity, buying, api }: CellProps) {
  const hovered = useStoreValue(api.hover, (cell) => cell !== null && cell.side === side && cell.price === price);
  const targeted = useStoreValue(api.drag.views, (view) => view?.target.kind === "cell" && view.target.side === side && view.target.price === price);
  const chipDragging = useStoreValue(api.drag.views, (view) => group !== undefined && view?.source.kind === "chip" && view.source.group === group);
  const showsPreview = hovered && writable && previewQuantity > 0;
  const previewTone = showsPreview && side === "buy" ? buyPreview(price, previewQuantity, buying) : null;
  return (
    <div
      className="od-cell"
      data-order-cell=""
      data-side={side}
      data-price={price}
      data-disabled={writable ? undefined : ""}
      data-target={targeted ? "" : undefined}
      onDoubleClick={() => { if (writable) api.actions.place(side, price); }}
      onPointerEnter={() => api.hover.set({ side, price })}
      onPointerLeave={() => api.hover.set(null)}
    >
      {group
        ? <button type="button" className="od-chip" data-testid="order-chip" data-side={side} data-price={price} data-dragging={chipDragging ? "" : undefined} data-pending={group.pending}
            data-add={showsPreview ? addQuantityText(previewQuantity) : undefined} data-add-over={showsPreview && previewTone === "over" ? "" : undefined} data-add-margin={showsPreview && previewTone === "margin" ? "" : undefined}
            aria-label={`${SIDE_LABEL[side]} ${formatPrice(price, false)}원 ${formatShares(group.quantity)} 주문${group.pending ? ` ${PENDING_TEXT[group.pending]}` : ""}`}
            onPointerDown={(e) => { if (writable && !group.pending) api.drag.begin({ source: { kind: "chip", group }, origin: null }, e); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (!group.pending) api.openMenu({ x: e.clientX, y: e.clientY, group }); }}>
            {group.quantity.toLocaleString("ko-KR")}
          </button>
        : showsPreview && <span className="od-preview" data-testid="order-preview" data-over={previewTone === "over" ? "" : undefined} data-margin={previewTone === "margin" ? "" : undefined}>{previewText(side, previewQuantity)}</span>}
    </div>
  );
});

export function OrderLadder({ rows, previousClose, groups, writable, previewQuantity, buying, hover, actions, averagePrice, divider, explorer, currentToken, ladder, drag, rowSlots, expectedPrice }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const dragging = useStoreValue(drag.views, (view) => view !== null);
  const api = useMemo<CellApi>(() => ({ hover, drag, actions, openMenu: setMenu }), [hover, drag, actions]);

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

  const hasCurrent = rows.some((row) => row.current);
  const placed = useRef<number | null>(null);
  const centerCurrentRow = useCallback(() => {
    const element = ladder.current;
    if (!element) return;
    const top = currentRowOffset(element);
    if (top === null) return;
    element.scrollTop = top;
    placed.current = element.scrollTop;
  }, [ladder]);

  useLayoutEffect(() => {
    const element = ladder.current;
    if (exploring || !element || !hasCurrent || placed.current !== null || element.scrollHeight <= element.clientHeight) return;
    centerCurrentRow();
  }, [exploring, hasCurrent, centerCurrentRow, ladder]);

  useLayoutEffect(() => {
    if (exploring || currentToken === 0) return;
    centerCurrentRow();
  }, [currentToken]);

  const onLadderScroll = () => {
    if (placed.current === null || ladder.current?.scrollTop !== placed.current) placed.current = -1;
    if (exploring) measureRange();
  };

  const cell = (slot: "left" | "right") => (row: LadderRow): ReactNode => {
    const side = SIDE_OF_SLOT[slot];
    if (row.price === null) return <div className="od-cell" data-empty="" data-side={side} />;
    return <OrderCell side={side} price={row.price} group={row.repeat ? undefined : groups.get(groupKey(side, row.price))} writable={writable} previewQuantity={previewQuantity} buying={buying} api={api} />;
  };
  const slots = { left: cell("left"), right: cell("right") };

  const all = [...groups.values()].filter((group) => !group.pending);
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
    <div ref={ladder} className="od-ladder" data-testid="order-ladder" data-explorer={exploring ? "" : undefined} data-dragging={dragging ? "" : undefined} data-divider={divider ? "" : undefined}
      onScroll={onLadderScroll}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, group: null }); }}>
      <LadderHead />
      {exploring
        ? <div className="od-explorer-rows" data-testid="order-explorer-rows" style={{ paddingTop: range.start * LADDER_ROW_HEIGHT_PX, paddingBottom: (rowCount - range.end) * LADDER_ROW_HEIGHT_PX }}>{ladderView}</div>
        : ladderView}
      {menu && <OrderList label={menu.group ? "주문 목록" : "주문 취소"} root={ladder} point={{ x: menu.x, y: menu.y }} drag={drag} items={items(menu)} onClose={() => setMenu(null)} />}
    </div>
  );
}
