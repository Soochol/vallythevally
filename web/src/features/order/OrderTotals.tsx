import { memo, useEffect, useRef, useState } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import { formatPrice } from "../../lib/format";
import { useStoreValue } from "../../lib/valueStore";
import { formatShares } from "../market-window/format";
import { OrderList, type OrderListItem } from "./OrderList";
import { type PriceGroup, type PriceKey, SIDE_LABEL, sideTotal } from "./orderRules";
import { REPLAY_LOCKED_TEXT } from "./statusText";
import type { OrderDrag } from "./useOrderDrag";

const COMPACT_FROM = 10_000;
const COMPACT_UNIT = 10_000;
const BLOCKED_DRAG_PX = 4;

const compactQuantity = (quantity: number): string =>
  quantity < COMPACT_FROM ? quantity.toLocaleString("ko-KR") : `${Number((quantity / COMPACT_UNIT).toFixed(1)).toLocaleString("ko-KR")}만`;

interface Actions {
  cancelOne(orderNo: string): void;
  cancelGroups(keys: readonly PriceKey[]): void;
}

export function OrderTotalCell({ side, groups, writable, replayLocked = false, onReplayBlocked, actions, drag }: { side: OrderSide; groups: ReadonlyMap<string, PriceGroup>; writable: boolean; replayLocked?: boolean; onReplayBlocked?: () => void; actions: Actions; drag: OrderDrag }) {
  const [open, setOpen] = useState(false);
  const dragging = useStoreValue(drag.views, (view) => view?.source.kind === "total" && view.source.side === side);
  const button = useRef<HTMLButtonElement>(null);
  const stopBlockedWatch = useRef<(() => void) | null>(null);
  useEffect(() => () => stopBlockedWatch.current?.(), []);
  const canEdit = writable && !replayLocked;
  const disabledTitle = replayLocked ? REPLAY_LOCKED_TEXT : undefined;
  const blockedDrag = writable && replayLocked ? onReplayBlocked : undefined;
  const total = sideTotal(groups, side);
  const sideGroups = [...groups.values()].filter((group) => group.side === side).sort((a, b) => b.price - a.price);
  const watchBlockedDrag = (event: React.PointerEvent) => {
    if (event.button !== 0 || !blockedDrag) return;
    stopBlockedWatch.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      if (stopBlockedWatch.current === cleanup) stopBlockedWatch.current = null;
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < BLOCKED_DRAG_PX) return;
      cleanup();
      const swallow = (clickEvent: MouseEvent) => { clickEvent.stopPropagation(); clickEvent.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      blockedDrag();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
    stopBlockedWatch.current = cleanup;
  };
  const items: OrderListItem[] = total.count === 0
    ? [{ kind: "heading", label: "걸려 있는 주문이 없습니다" }]
    : [
      { kind: "heading", label: `${SIDE_LABEL[side]} 접수 ${total.count}건` },
      ...sideGroups.flatMap((group) => group.orders.map((order): OrderListItem => ({
        kind: "cancelRow",
        order,
        label: `${formatPrice(order.price, false)}원 · ${order.openQuantity.toLocaleString("ko-KR")}`,
        disabled: !canEdit,
        title: disabledTitle,
        onBlockedDrag: blockedDrag,
        onSelect: () => actions.cancelOne(order.orderNo),
      }))),
      { kind: "separator" },
      {
        kind: "action",
        label: `${SIDE_LABEL[side]} 모두 취소`,
        danger: true,
        disabled: !canEdit,
        title: disabledTitle,
        onSelect: () => actions.cancelGroups(sideGroups),
      },
    ];
  return (
    <>
      <button ref={button} type="button" className="od-total" data-testid={`order-total-${side}`} data-side={side} data-empty={total.count === 0 ? "" : undefined} data-drag-disabled={canEdit ? undefined : ""}
        title={`${SIDE_LABEL[side]} 접수 ${formatShares(total.quantity)} ${total.count}건`} aria-label={`${SIDE_LABEL[side]} 접수 ${formatShares(total.quantity)} ${total.count}건`} aria-haspopup="menu" aria-expanded={open}
        data-dragging={dragging ? "" : undefined}
        onPointerDown={(e) => {
          if (total.count === 0) return;
          if (canEdit) drag.begin({ source: { kind: "total", side, groups: sideGroups }, origin: e.currentTarget.getBoundingClientRect(), onMoved: () => setOpen(false) }, e);
          else watchBlockedDrag(e);
        }}
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
