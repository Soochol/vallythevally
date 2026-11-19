import { useRef, useState } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import { formatPrice } from "../../lib/format";
import { Menu, type MenuItem } from "../menu/Menu";
import { formatShares } from "../market-window/format";
import { type PriceGroup, SIDE_LABEL, sideTotal } from "./orderRules";

const COMPACT_FROM = 10_000;
const COMPACT_UNIT = 10_000;

const compactQuantity = (quantity: number): string =>
  quantity < COMPACT_FROM ? quantity.toLocaleString("ko-KR") : `${Number((quantity / COMPACT_UNIT).toFixed(1)).toLocaleString("ko-KR")}만`;

interface Actions {
  cancelOne(orderNo: string): void;
  cancelAtPrice(side: OrderSide, price: number): void;
}

function OrderTotalCell({ side, groups, writable, actions }: { side: OrderSide; groups: ReadonlyMap<string, PriceGroup>; writable: boolean; actions: Actions }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const total = sideTotal(groups, side);
  const sideGroups = [...groups.values()].filter((group) => group.side === side).sort((a, b) => b.price - a.price);
  const items: MenuItem[] = total.count === 0
    ? [{ kind: "heading", label: "걸려 있는 주문이 없습니다" }]
    : [
      { kind: "heading", label: `${SIDE_LABEL[side]} 접수 ${total.count}건` },
      ...sideGroups.flatMap((group) => group.orders.map((order): MenuItem => ({
        kind: "action",
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
        onSelect: () => sideGroups.forEach((group) => actions.cancelAtPrice(group.side, group.price)),
      },
    ];
  return (
    <>
      <button ref={button} type="button" className="od-total" data-testid={`order-total-${side}`} data-side={side} data-empty={total.count === 0 ? "" : undefined}
        aria-label={`${SIDE_LABEL[side]} 접수 ${formatShares(total.quantity)} ${total.count}건`} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((was) => !was)}>
        {compactQuantity(total.quantity)} ({total.count})
      </button>
      {open && <Menu label={`${SIDE_LABEL[side]} 접수 주문`} root={button} placement="top" items={items} onClose={() => setOpen(false)} />}
    </>
  );
}

export function OrderTotals({ groups, writable, actions }: { groups: ReadonlyMap<string, PriceGroup>; writable: boolean; actions: Actions }) {
  return (
    <div className="od-totals" data-testid="order-totals">
      <OrderTotalCell side="sell" groups={groups} writable={writable} actions={actions} />
      <OrderTotalCell side="buy" groups={groups} writable={writable} actions={actions} />
    </div>
  );
}
