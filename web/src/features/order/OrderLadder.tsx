import { memo, type ReactNode, type RefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import { formatPrice } from "../../lib/format";
import { useStoreValue, type ValueStore } from "../../lib/valueStore";
import type { LadderRow } from "../market-window/ladder";
import { type DayPrices, ladderColumns, type LadderRowSlots, PriceLadder } from "../market-window/PriceLadder";
import { formatShares } from "../market-window/format";
import { type BuyingPower, buyPreview, groupKey, type PriceGroup, type PriceKey, previewText, SIDE_LABEL } from "./orderRules";
import { PENDING_CHIP_TEXT, PENDING_TEXT } from "./statusText";
import { LADDER_ROW_HEIGHT_PX, type RowRange, scrollTopToCenter, visibleRowRange } from "./priceRange";
import { OrderList, type OrderListItem } from "./OrderList";
import { resolveOrderCellAt } from "./nearestCell";
import type { OrderDrag } from "./useOrderDrag";

export interface HoverCell {
  readonly side: OrderSide;
  readonly price: number;
  readonly rowKey: string;
}

export interface LadderActions {
  place(side: OrderSide, price: number): void;
  cancelOne(orderNo: string): void;
  cancelGroups(keys: readonly PriceKey[]): void;
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
  readonly dayPrices?: DayPrices | null;
  readonly divider: boolean;
  readonly rateShown: boolean;
  readonly explorerOn: boolean;
  readonly explorerUnavailable: boolean;
  readonly explorerTitle: string | undefined;
  readonly onToggleExplorer: () => void;
  readonly explorerCenterPrice: number | null;
  readonly ladder: RefObject<HTMLDivElement | null>;
  readonly drag: OrderDrag;
  readonly rowSlots?: LadderRowSlots;
  readonly expectedPrice?: number | null;
}

type MenuState = { readonly x: number; readonly y: number; readonly group: PriceKey | null };

const SIDE_OF_SLOT: Readonly<Record<"left" | "right", OrderSide>> = { left: "sell", right: "buy" };

function repeatedPrices(rows: readonly LadderRow[]): ReadonlySet<number> | null {
  let repeated: Set<number> | null = null;
  for (const row of rows) {
    if (row.repeat && row.price !== null) {
      repeated ??= new Set();
      repeated.add(row.price);
    }
  }
  return repeated;
}

const chipVisible = (side: OrderSide, row: LadderRow, repeated: ReadonlySet<number> | null): boolean =>
  row.price === null || repeated === null || !repeated.has(row.price) ? true : side === "buy" ? row.repeat : !row.repeat;

interface CellApi {
  readonly hover: ValueStore<HoverCell | null>;
  readonly drag: OrderDrag;
  readonly actions: LadderActions;
  readonly openMenu: (menu: MenuState) => void;
}

interface CellProps {
  readonly rowKey: string;
  readonly side: OrderSide;
  readonly price: number;
  readonly group: PriceGroup | undefined;
  readonly writable: boolean;
  readonly previewQuantity: number;
  readonly buying: BuyingPower | null;
  readonly api: CellApi;
}

const HEAD_COLUMNS = ladderColumns(true, true);

interface HeadProps {
  readonly explorerOn: boolean;
  readonly explorerUnavailable: boolean;
  readonly explorerTitle: string | undefined;
  readonly onToggleExplorer: () => void;
}

const LadderHead = memo(function LadderHead({ explorerOn, explorerUnavailable, explorerTitle, onToggleExplorer }: HeadProps) {
  return (
    <div className="od-colhead" data-testid="order-colhead" style={{ gridTemplateColumns: HEAD_COLUMNS }}>
      <span>매도주문</span>
      <span>매도잔량</span>
      <button type="button" className="od-colhead-explorer" data-testid="order-explorer" aria-pressed={explorerOn} disabled={explorerUnavailable} title={explorerTitle} onClick={onToggleExplorer}>전체호가</button>
      <span>매수잔량</span>
      <span>매수주문</span>
    </div>
  );
});

const centerRowOffset = (element: HTMLElement, fallbackToBid: boolean): number | null => {
  const row = element.querySelector<HTMLElement>(".mw-lr[data-current]") ?? (fallbackToBid ? element.querySelector<HTMLElement>('.mw-lr[data-side="bid"]') : null);
  if (row === null) return null;
  const head = element.querySelector<HTMLElement>(".od-colhead")?.offsetHeight ?? 0;
  const rowCenter = row.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop + row.offsetHeight / 2;
  return Math.max(0, rowCenter - head - (element.clientHeight - head) / 2);
};

const OrderCell = memo(function OrderCell({ rowKey, side, price, group, writable, previewQuantity, buying, api }: CellProps) {
  const hovered = useStoreValue(api.hover, (cell) => cell !== null && cell.side === side && cell.rowKey === rowKey);
  const targeted = useStoreValue(api.drag.views, (view) =>
    view?.target.kind === "cell"
    && view.target.side === side
    && view.target.price === price
    && (view.target.rowKey === undefined || view.target.rowKey === rowKey),
  );
  const chipDragging = useStoreValue(api.drag.views, (view) => group !== undefined && view?.source.kind === "chip" && view.source.group === group);
  const showsPreview = hovered && writable && group === undefined && previewQuantity > 0;
  const previewTone = showsPreview && side === "buy" ? buyPreview(price, previewQuantity, buying) : null;
  return (
    <div
      className="od-cell"
      data-order-cell=""
      data-side={side}
      data-price={price}
      data-row-key={rowKey}
      data-disabled={writable ? undefined : ""}
      data-target={targeted ? "" : undefined}
      onPointerEnter={() => api.hover.set({ side, price, rowKey })}
      onPointerLeave={() => {
        const current = api.hover.get();
        if (current !== null && current.side === side && current.rowKey === rowKey) api.hover.set(null);
      }}
    >
      {group
        ? <button type="button" className="od-chip" data-testid="order-chip" data-side={side} data-price={price} data-dragging={chipDragging ? "" : undefined} data-pending={group.pending}
            aria-label={`${SIDE_LABEL[side]} ${formatPrice(price, false)}원 ${formatShares(group.quantity)} 주문${group.pending ? ` ${PENDING_TEXT[group.pending]}` : ""}`}
            onPointerDown={(e) => { if (writable && !group.pending) api.drag.begin({ source: { kind: "chip", group }, origin: null }, e); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (!group.pending) api.openMenu({ x: e.clientX, y: e.clientY, group }); }}>
            {group.quantity.toLocaleString("ko-KR")}{group.pending && <span className="od-chip-state"> {PENDING_CHIP_TEXT[group.pending]}</span>}
          </button>
        : showsPreview && <span className="od-preview" data-testid="order-preview" data-over={previewTone === "over" ? "" : undefined} data-margin={previewTone === "margin" ? "" : undefined}>{previewText(side, previewQuantity)}</span>}
    </div>
  );
});

export function OrderLadder({ rows, previousClose, groups, writable, previewQuantity, buying, hover, actions, averagePrice, dayPrices = null, divider, rateShown, explorerOn, explorerUnavailable, explorerTitle, onToggleExplorer, explorerCenterPrice, ladder, drag, rowSlots, expectedPrice }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const dragging = useStoreValue(drag.views, (view) => view !== null);
  const api = useMemo<CellApi>(() => ({ hover, drag, actions, openMenu: setMenu }), [hover, drag, actions]);

  const exploring = explorerOn;
  const [range, setRange] = useState<RowRange>({ start: 0, end: 0 });
  const rowCount = rows.length;
  const centerIndex = explorerCenterPrice === null ? -1 : rows.findIndex((row) => row.price !== null && row.price <= explorerCenterPrice);

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
  }, [exploring]);

  const hasCurrent = rows.some((row) => row.current);
  const placed = useRef<number | null>(null);
  const wasExploring = useRef(exploring);
  const centerCurrentRow = useCallback((fallbackToBid: boolean) => {
    const element = ladder.current;
    if (!element) return;
    const top = centerRowOffset(element, fallbackToBid);
    if (top === null) {
      if (fallbackToBid) placed.current = element.scrollTop;
      return;
    }
    element.scrollTop = top;
    placed.current = element.scrollTop;
  }, [ladder]);

  useLayoutEffect(() => {
    const element = ladder.current;
    if (exploring || !element || !hasCurrent || placed.current !== null || element.scrollHeight <= element.clientHeight) return;
    centerCurrentRow(false);
  }, [exploring, hasCurrent, centerCurrentRow, ladder]);

  useLayoutEffect(() => {
    const turnedOff = wasExploring.current && !exploring;
    wasExploring.current = exploring;
    if (turnedOff) centerCurrentRow(true);
  }, [exploring, centerCurrentRow]);

  const onLadderScroll = () => {
    if (placed.current === null || ladder.current?.scrollTop !== placed.current) placed.current = -1;
    if (exploring) measureRange();
  };

  const repeated = exploring ? null : repeatedPrices(rows);
  const cell = (slot: "left" | "right") => (row: LadderRow): ReactNode => {
    const side = SIDE_OF_SLOT[slot];
    if (row.price === null) return <div className="od-cell" data-empty="" data-side={side} />;
    const group = chipVisible(side, row, repeated) ? groups.get(groupKey(side, row.price)) : undefined;
    return <OrderCell rowKey={row.key} side={side} price={row.price} group={group} writable={writable} previewQuantity={previewQuantity} buying={buying} api={api} />;
  };
  const slots = { left: cell("left"), right: cell("right") };

  const all = [...groups.values()].filter((group) => !group.pending);
  const items = (state: MenuState): OrderListItem[] => {
    const { group } = state;
    if (group) {
      const keys = [group];
      const orders = groups.get(groupKey(group.side, group.price))?.orders ?? [];
      return [
        { kind: "heading", label: `${formatPrice(group.price, false)}원 ${SIDE_LABEL[group.side]} 주문` },
        ...orders.map((order): OrderListItem => ({ kind: "order", label: `${order.openQuantity.toLocaleString("ko-KR")} 취소`, order, disabled: !writable, onSelect: () => actions.cancelOne(order.orderNo) })),
        { kind: "separator" },
        { kind: "action", label: "이 가격 모두 취소", danger: true, disabled: !writable || orders.length === 0, onSelect: () => actions.cancelGroups(keys) },
      ];
    }
    const side = (s: OrderSide) => all.filter((g) => g.side === s);
    const entry = (prefix: string, targets: readonly PriceGroup[]): OrderListItem => ({ kind: "action", label: `${prefix} 모두 취소`, danger: true, disabled: !writable || targets.length === 0, onSelect: () => actions.cancelGroups(targets) });
    return [entry("매수", side("buy")), entry("매도", side("sell")), entry("전체", all)];
  };

  const shown = exploring ? rows.slice(range.start, range.end) : rows;
  const ladderView = <PriceLadder rows={shown} previousClose={previousClose} rateShown={rateShown} slots={slots} rowSlots={exploring ? undefined : rowSlots} mark={{ price: averagePrice, label: "평단가" }} dayPrices={dayPrices} expectedPrice={expectedPrice} firstBidIndex={exploring ? Math.max(0, (centerIndex < 0 ? rowCount : centerIndex) - range.start) : undefined} />;

  return (
    <div ref={ladder} className="od-ladder" data-testid="order-ladder" data-explorer={exploring ? "" : undefined} data-dragging={dragging ? "" : undefined} data-divider={divider ? "" : undefined}
      onScroll={onLadderScroll}
      onDoubleClick={(e) => {
        if (!writable || !ladder.current) return;
        const resolved = resolveOrderCellAt(ladder.current, e.clientX, e.clientY, e.target);
        if (resolved !== null) actions.place(resolved.side, resolved.price);
      }}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, group: null }); }}>
      <LadderHead explorerOn={explorerOn} explorerUnavailable={explorerUnavailable} explorerTitle={explorerTitle} onToggleExplorer={onToggleExplorer} />
      {exploring
        ? <div className="od-explorer-rows" data-testid="order-explorer-rows" style={{ paddingTop: range.start * LADDER_ROW_HEIGHT_PX, paddingBottom: (rowCount - range.end) * LADDER_ROW_HEIGHT_PX }}>{ladderView}</div>
        : ladderView}
      {menu && <OrderList label={menu.group ? "주문 목록" : "주문 취소"} root={ladder} point={{ x: menu.x, y: menu.y }} drag={drag} items={items(menu)} onClose={() => setMenu(null)} />}
    </div>
  );
}
