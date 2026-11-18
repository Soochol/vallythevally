import { type ReactNode, useEffect, useRef, useState } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import { formatPrice } from "../../lib/format";
import { Menu, type MenuItem } from "../menu/Menu";
import type { LadderRow } from "../market-window/ladder";
import { PriceLadder } from "../market-window/PriceLadder";
import { formatShares } from "../market-window/format";
import { dragGhostText, groupKey, type PriceGroup, previewText, SIDE_LABEL } from "./orderRules";
import { useChipDrag } from "./useChipDrag";
import type { DragOutcome } from "./orderRules";

export interface HoverCell {
  readonly side: OrderSide;
  readonly price: number;
}

export interface LadderActions {
  place(side: OrderSide, price: number): void;
  drop(group: PriceGroup, outcome: DragOutcome): void;
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
  readonly onWheel?: (direction: 1 | -1) => void;
  readonly onDragging: (dragging: boolean) => void;
  readonly children?: ReactNode;
}

type MenuState = { readonly x: number; readonly y: number; readonly group: PriceGroup | null };

const SIDE_OF_SLOT: Readonly<Record<"left" | "right", OrderSide>> = { left: "sell", right: "buy" };

export function OrderLadder({ rows, previousClose, groups, writable, previewQuantity, hover, onHover, actions, averagePrice, divider, onWheel, onDragging, children }: Props) {
  const ladder = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const { view, begin } = useChipDrag(ladder, actions.drop);
  const dragging = view !== null;

  useEffect(() => { onDragging(dragging); }, [dragging, onDragging]);

  useEffect(() => {
    const element = ladder.current;
    if (!element || !onWheel) return;
    const handle = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      onWheel(event.deltaY < 0 ? 1 : -1);
    };
    element.addEventListener("wheel", handle, { passive: false });
    return () => element.removeEventListener("wheel", handle);
  }, [onWheel]);

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
        {group
          ? <button type="button" className="od-chip" data-testid="order-chip" data-side={side} data-price={price} data-dragging={view?.group === group ? "" : undefined}
              aria-label={`${SIDE_LABEL[side]} ${formatPrice(price, false)}원 ${formatShares(group.quantity)} 주문`}
              onPointerDown={(e) => { if (writable) begin(group, e); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, group }); }}>
              {group.quantity.toLocaleString("ko-KR")}
            </button>
          : hovered && writable && previewQuantity > 0 && <span className="od-preview">{previewText(side, previewQuantity)}</span>}
      </div>
    );
  };
  const slots = { left: cell("left"), right: cell("right") };

  const all = [...groups.values()];
  const items = (state: MenuState): MenuItem[] => {
    const { group } = state;
    if (group) {
      return [
        { kind: "heading", label: `${formatPrice(group.price, false)}원 ${SIDE_LABEL[group.side]} 주문` },
        ...group.orders.map((order): MenuItem => ({ kind: "action", label: `${order.openQuantity.toLocaleString("ko-KR")}주 취소`, disabled: !writable, onSelect: () => actions.cancelOne(order.orderNo) })),
        { kind: "separator" },
        { kind: "action", label: "이 가격 모두 취소", danger: true, disabled: !writable, onSelect: () => actions.cancelAtPrice(group.side, group.price) },
      ];
    }
    const side = (s: OrderSide) => all.filter((g) => g.side === s);
    const entry = (label: string, targets: readonly PriceGroup[]): MenuItem => ({ kind: "action", label, danger: true, disabled: !writable || targets.length === 0, onSelect: () => actions.cancelGroups(targets) });
    return [entry("매수 모두 취소", side("buy")), entry("매도 모두 취소", side("sell")), entry("전체 모두 취소", all)];
  };

  return (
    <div ref={ladder} className="od-ladder" data-testid="order-ladder" data-dragging={view ? "" : undefined} data-divider={divider ? "" : undefined}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, group: null }); }}>
      <PriceLadder rows={rows} previousClose={previousClose} slots={slots} mark={{ price: averagePrice, label: "평단가" }} />
      {children}
      {view && <div className="od-ghost" data-testid="order-ghost" data-side={view.group.side} style={{ left: view.x, top: view.y }}>
        <b>{view.group.quantity.toLocaleString("ko-KR")}</b> {dragGhostText(view.target, view.group)}
      </div>}
      {menu && <Menu label={menu.group ? "주문 목록" : "주문 취소"} root={ladder} style={{ left: menu.x, top: menu.y }} items={items(menu)} onClose={() => setMenu(null)} />}
    </div>
  );
}
