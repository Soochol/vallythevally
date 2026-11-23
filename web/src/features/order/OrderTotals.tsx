import { memo, useRef, useState } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import { formatPrice } from "../../lib/format";
import { useStoreValue } from "../../lib/valueStore";
import { formatShares } from "../market-window/format";
import { OrderList, type OrderListItem } from "./OrderList";
import { cancelConfirmText, needsCancelConfirm, type PriceGroup, SIDE_LABEL, sideTotal } from "./orderRules";
import type { OrderDrag } from "./useOrderDrag";

const COMPACT_FROM = 10_000;
const COMPACT_UNIT = 10_000;

const compactQuantity = (quantity: number): string =>
  quantity < COMPACT_FROM ? quantity.toLocaleString("ko-KR") : `${Number((quantity / COMPACT_UNIT).toFixed(1)).toLocaleString("ko-KR")}만`;

interface Actions {
  cancelOne(orderNo: string): void;
  cancelAtPrice(side: OrderSide, price: number): void;
}

function OrderTotalCell({ side, groups, writable, actions, drag }: { side: OrderSide; groups: ReadonlyMap<string, PriceGroup>; writable: boolean; actions: Actions; drag: OrderDrag }) {
  const [open, setOpen] = useState(false);
  const dragging = useStoreValue(drag.views, (view) => view?.source.kind === "total" && view.source.side === side);
  const button = useRef<HTMLButtonElement>(null);
  const total = sideTotal(groups, side);
  const sideGroups = [...groups.values()].filter((group) => group.side === side).sort((a, b) => b.price - a.price);
  const items: OrderListItem[] = total.count === 0
    ? [{ kind: "heading", label: "걸려 있는 주문이 없습니다" }]
    : [
      { kind: "heading", label: `${SIDE_LABEL[side]} 접수 ${total.count}건` },
      ...sideGroups.flatMap((group) => group.orders.map((order): OrderListItem => ({
        kind: "cancelRow",
        order,
        label: `${formatPrice(order.price, false)}원 · ${order.openQuantity.toLocaleString("ko-KR")}`,
        disabled: !writable,
        onSelect: () => actions.cancelOne(order.orderNo),
      }))),
      { kind: "separator" },
      {
        kind: "action",
        label: `${SIDE_LABEL[side]} 모두 취소`,
        danger: true,
        disabled: !writable,
        confirm: needsCancelConfirm(total.count) ? `${SIDE_LABEL[side]} ${cancelConfirmText(total.count)}` : undefined,
        onSelect: () => sideGroups.forEach((group) => actions.cancelAtPrice(group.side, group.price)),
      },
    ];
  return (
    <>
      <button ref={button} type="button" className="od-total" data-testid={`order-total-${side}`} data-side={side} data-empty={total.count === 0 ? "" : undefined}
        title={`${SIDE_LABEL[side]} 접수 ${formatShares(total.quantity)} ${total.count}건`} aria-label={`${SIDE_LABEL[side]} 접수 ${formatShares(total.quantity)} ${total.count}건`} aria-haspopup="menu" aria-expanded={open}
        data-dragging={dragging ? "" : undefined}
        onPointerDown={(e) => { if (writable && total.count > 0) drag.begin({ source: { kind: "total", side, groups: sideGroups }, origin: e.currentTarget.getBoundingClientRect(), onMoved: () => setOpen(false) }, e); }}
        onClick={() => setOpen((was) => !was)}>
        {compactQuantity(total.quantity)} ({total.count})
      </button>
      {open && <OrderList label={`${SIDE_LABEL[side]} 접수 주문`} root={button} placement="top" drag={drag} items={items} onClose={() => setOpen(false)} />}
    </>
  );
}

export const OrderTotals = memo(function OrderTotals({ groups, writable, actions, drag }: { groups: ReadonlyMap<string, PriceGroup>; writable: boolean; actions: Actions; drag: OrderDrag }) {
  return (
    <div className="od-totals" data-testid="order-totals">
      <OrderTotalCell side="sell" groups={groups} writable={writable} actions={actions} drag={drag} />
      <OrderTotalCell side="buy" groups={groups} writable={writable} actions={actions} drag={drag} />
    </div>
  );
});
