import { useState } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { WindowId } from "../../layout/kinds";
import { formatPrice } from "../../lib/format";
import { isIndexCode } from "../../lib/symbol";
import { orderVenue, useLayoutStore } from "../../stores/layout";
import { useBookFeed } from "../book/useBookFeed";
import { buildLadder } from "../market-window/ladder";
import { useLinkedSymbol } from "../market-window/MarketWindowGate";
import { formatShares } from "../market-window/format";
import { EmptyState } from "../overlay/State";
import { openSystemSettings } from "../system-settings/open";
import { HighValueConfirm, type HighValueRequest } from "./HighValueConfirm";
import { type HoverCell, OrderLadder } from "./OrderLadder";
import { OrderStatusBar } from "./OrderStatusBar";
import { QuantityRow } from "./QuantityRow";
import { capacityProblem, type DragOutcome, needsHighValueConfirm, type PriceGroup, quantityOf, type QuantityMode, SIDE_LABEL, sideTotal } from "./orderRules";
import { useOrderAccess, useOrderData } from "./useOrderData";
import { useOrderWrites } from "./useOrderWrites";

const SIDES: readonly OrderSide[] = ["sell", "buy"];

function OpenOrderList({ groups, writable, onCancel }: { groups: ReadonlyMap<string, PriceGroup>; writable: boolean; onCancel(orderNo: string): void }) {
  const orders = [...groups.values()].sort((a, b) => b.price - a.price).flatMap((group) => group.orders);
  if (orders.length === 0) return <div className="od-list" data-testid="order-list"><p className="od-list-empty">걸려 있는 주문이 없습니다</p></div>;
  return (
    <ul className="od-list" data-testid="order-list">
      {orders.map((order) => (
        <li key={order.orderNo} data-side={order.side}>
          <span>{SIDE_LABEL[order.side]}</span>
          <b>{formatPrice(order.price, false)}원</b>
          <span>{formatShares(order.openQuantity)}</span>
          <button type="button" className="od-link" disabled={!writable} onClick={() => onCancel(order.orderNo)}>취소</button>
        </li>
      ))}
    </ul>
  );
}

function OrderBody({ id, code }: { id: WindowId; code: SymbolCode }) {
  const venue = useLayoutStore((s) => orderVenue(s.layout, id));
  const setVenue = useLayoutStore((s) => s.setOrderVenue);
  const feed = useBookFeed(code);
  const access = useOrderAccess();
  const [mode, setMode] = useState<QuantityMode>("shares");
  const [input, setInput] = useState("10");
  const [hover, setHover] = useState<HoverCell | null>(null);
  const [confirm, setConfirm] = useState<HighValueRequest | null>(null);
  const [listOpen, setListOpen] = useState(false);

  const view = feed.book.phase === "empty" ? null : feed.book.view;
  const rows = view ? buildLadder({ asks: view.asks, bids: view.bids, lastPrice: feed.lastPrice, previousClose: feed.previousClose }) : [];
  const referencePrice = feed.lastPrice ?? feed.previousClose ?? rows.find((row) => row.level)?.level?.price ?? null;
  const data = useOrderData(code, access.open, referencePrice);
  const writes = useOrderWrites(code, venue);
  const writable = access.open && !data.blocked && writes.status.unknown !== true;

  const typed = Number(input);
  const unitPrice = hover?.price ?? referencePrice ?? 0;
  const quantityAt = (price: number) => quantityOf(mode, typed, price);
  const estimate = unitPrice > 0 && quantityAt(unitPrice) > 0 ? unitPrice * quantityAt(unitPrice) : null;

  const place = (side: OrderSide, price: number) => {
    const quantity = quantityAt(price);
    const problem = capacityProblem(side, price, quantity, data.capacity);
    if (problem) {
      writes.say({ tone: "error", text: problem });
      return;
    }
    const send = (confirmHighValue: boolean) => writes.place({ side, price, quantity, confirmHighValue });
    if (needsHighValueConfirm(price, quantity)) setConfirm({ title: `${SIDE_LABEL[side]} ${formatShares(quantity)} · ${formatPrice(price, false)}원`, amount: price * quantity, run: () => send(true) });
    else send(false);
  };

  const drop = (group: PriceGroup, outcome: DragOutcome) => {
    if (outcome.kind === "cancel") writes.cancelAtPrice(group.side, group.price);
    if (outcome.kind !== "modify") return;
    const run = () => writes.modifyAll(group.orders, outcome.price);
    if (group.orders.some((order) => needsHighValueConfirm(outcome.price, order.openQuantity))) setConfirm({ title: `${SIDE_LABEL[group.side]} 정정 · ${formatPrice(group.price, false)}원 → ${formatPrice(outcome.price, false)}원`, amount: outcome.price * group.quantity, run });
    else run();
  };

  return (
    <div className="od" data-testid="order-window" data-symbol={code} data-venue={venue} data-writable={writable ? "" : undefined}>
      {access.reason && (
        <div className="od-gate" role="status" data-testid="order-gate">
          <span>{access.reason}</span>
          <button type="button" className="od-link" onClick={() => openSystemSettings("kiwoom")}>시스템 설정 열기</button>
        </div>
      )}
      <div className="bk-ladder od-ladder-wrap" data-stale={feed.connected ? undefined : ""}>
        {view
          ? <OrderLadder rows={rows} previousClose={feed.previousClose} groups={data.groups} writable={writable} previewQuantity={quantityAt(unitPrice)} hover={hover} onHover={setHover}
              actions={{ place, drop, cancelOne: writes.cancelOne, cancelAtPrice: writes.cancelAtPrice, cancelGroups: (targets) => targets.forEach((g) => writes.cancelAtPrice(g.side, g.price)) }} />
          : <EmptyState title={feed.snapshotFailed ? "호가를 불러오지 못했습니다" : "호가를 기다리는 중입니다"} />}
      </div>
      <div className="od-totals">
        {SIDES.map((side) => {
          const total = sideTotal(data.groups, side);
          return <button key={side} type="button" className="od-total" data-side={side} data-testid={`order-total-${side}`} aria-expanded={listOpen} onClick={() => setListOpen((open) => !open)}>
            {SIDE_LABEL[side]} 접수 <b>{formatShares(total.quantity)}</b> ({total.count}건)
          </button>;
        })}
      </div>
      {listOpen && <OpenOrderList groups={data.groups} writable={writable} onCancel={writes.cancelOne} />}
      <QuantityRow mode={mode} input={input} estimate={estimate} venue={venue} onMode={setMode} onInput={setInput} onVenue={(next) => setVenue(id, next)} />
      <OrderStatusBar status={writes.status} queued={writes.queued} blocked={data.blocked} onUndo={writes.cancelOne} onReconcile={writes.reconcile} />
      {confirm && <HighValueConfirm request={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

export function OrderWindow({ id }: { id: WindowId }) {
  const code = useLinkedSymbol(id);
  if (code === null) return <EmptyState title="연동된 종목이 없습니다" />;
  if (isIndexCode(code)) return <EmptyState title="이 창은 주식만 보입니다" />;
  return <OrderBody key={code} id={id} code={code} />;
}
