import { useCallback, useEffect, useState } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { WindowId } from "../../layout/kinds";
import { useFundamentals, useSymbolInfo } from "../../api/queries";
import { useOrdersStatus } from "../../api/system";
import { secondOfDay } from "../trades/tape";
import { formatPrice } from "../../lib/format";
import { isIndexCode } from "../../lib/symbol";
import { orderVenue, useLayoutStore } from "../../stores/layout";
import { useOrderSettings, useUiStore } from "../../stores/ui";
import { useBookFeed } from "../book/useBookFeed";
import { buildLadder, type LadderRow } from "../market-window/ladder";
import { RatioBar, Segmented, Strip } from "../market-window/parts";
import { useLinkedSymbol } from "../market-window/MarketWindowGate";
import { formatShares } from "../market-window/format";
import { EmptyState } from "../overlay/State";
import { openSystemSettings } from "../system-settings/open";
import { AccountBand } from "./AccountBand";
import { buildExplorerRows } from "./explorerRows";
import { averageRowPrice, holdingOf, ladderClosed, type ProfitUnit, type SessionChoice, toggledUnit } from "./holdingSummary";
import { HoldingSummary } from "./HoldingSummary";
import { LadderTape, QuoteSummary } from "./LadderOverlays";
import { OrderSettingsPopover } from "./OrderSettingsPopover";
import { explorerPrices, movePrice } from "./priceRange";
import { HighValueConfirm, type HighValueRequest } from "./HighValueConfirm";
import { type HoverCell, OrderLadder } from "./OrderLadder";
import { OrderStatusBar } from "./OrderStatusBar";
import { QuantityRow } from "./QuantityRow";
import { capacityProblem, type DragOutcome, needsHighValueConfirm, type PriceGroup, quantityOf, type QuantityMode, SIDE_LABEL, sideTotal } from "./orderRules";
import { useOrderAccess, useOrderData } from "./useOrderData";
import { useOrderWrites } from "./useOrderWrites";

const SIDES: readonly OrderSide[] = ["sell", "buy"];
const WHEEL_TICKS = 5;
const CLOCK_MS = 30_000;
const SESSIONS: readonly { readonly value: SessionChoice; readonly label: string }[] = [{ value: "regular", label: "정규장" }, { value: "after", label: "시간외" }];

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
  const [explorerCenter, setExplorerCenter] = useState<number | null>(null);
  const [profitUnit, setProfitUnit] = useState<ProfitUnit>("won");
  const [session, setSession] = useState<SessionChoice>("regular");
  const [now, setNow] = useState(() => Date.now());
  const settings = useOrderSettings();
  const setSettings = useUiStore((s) => s.setOrderSettings);
  const limits = useFundamentals(code).data;
  const nxtEnabled = useSymbolInfo(code).data?.nxtEnabled ?? null;
  const accountTail = useOrdersStatus().data?.accountTail ?? null;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const view = feed.book.phase === "empty" ? null : feed.book.view;
  const bounds = { lower: limits?.lowerLimit ?? null, upper: limits?.upperLimit ?? null };
  const liveRows = view ? buildLadder({ asks: view.asks, bids: view.bids, lastPrice: feed.lastPrice, previousClose: feed.previousClose }) : [];
  const referencePrice = feed.lastPrice ?? feed.previousClose ?? liveRows.find((row) => row.level)?.level?.price ?? null;
  const exploring = explorerCenter !== null;
  const shownRows: LadderRow[] = view && exploring
    ? buildExplorerRows({ prices: explorerPrices(explorerCenter, bounds), asks: view.asks, bids: view.bids, lastPrice: feed.lastPrice, previousClose: feed.previousClose })
    : liveRows;
  const rows = settings.rate ? shownRows : shownRows.map((row) => ({ ...row, rate: null }));
  const closed = ladderClosed(session, secondOfDay(now / 1000), nxtEnabled);
  const wheel = useCallback((direction: 1 | -1) => {
    if (referencePrice === null) return;
    setExplorerCenter((center) => movePrice(center ?? referencePrice, direction * WHEEL_TICKS, bounds));
  }, [referencePrice, bounds.lower, bounds.upper]);
  const data = useOrderData(code, access.open, referencePrice);
  const writes = useOrderWrites(code, venue);
  const holding = holdingOf(data.balance?.holdings ?? [], code);
  const averagePrice = settings.averageDot ? averageRowPrice(rows.map((row) => row.level?.price ?? null), holding?.averagePrice ?? null) : null;
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
      <AccountBand accountTail={accountTail} openOrders={data.openOrders} balance={data.balance} executions={data.executions} writable={writable} onCancel={writes.cancelOne} />
      <HoldingSummary holding={holding} buyableAmount={data.capacity.buyableAmount} unit={profitUnit} onUnit={() => setProfitUnit(toggledUnit)} onFill={(fill) => { setMode(fill.mode); setInput(fill.input); }} />
      <div className="od-toolbar">
        <button type="button" className="od-tool" data-testid="order-explorer" aria-pressed={exploring} disabled={referencePrice === null} onClick={() => setExplorerCenter(exploring ? null : referencePrice)}>전체 호가</button>
        <button type="button" className="od-tool" data-testid="order-current" disabled={!exploring} onClick={() => setExplorerCenter(null)}>현재가</button>
        <OrderSettingsPopover settings={settings} onChange={setSettings} />
      </div>
      <div className="bk-ladder od-ladder-wrap" data-stale={feed.connected ? undefined : ""} data-exploring={exploring ? "" : undefined}>
        {closed
          ? <EmptyState title="호가 사다리 없음">{session === "after" ? <p>시간외에는 호가 사다리를 보이지 않습니다</p> : <p>이 종목은 15:30 뒤 호가가 멈춥니다</p>}</EmptyState>
          : view
            ? <OrderLadder rows={rows} previousClose={feed.previousClose} groups={data.groups} writable={writable} previewQuantity={quantityAt(unitPrice)} hover={hover} onHover={setHover} averagePrice={averagePrice} divider={settings.divider} onWheel={wheel}
                actions={{ place, drop, cancelOne: writes.cancelOne, cancelAtPrice: writes.cancelAtPrice, cancelGroups: (targets) => targets.forEach((g) => writes.cancelAtPrice(g.side, g.price)) }}>
                <LadderTape code={code} venue={venue} previousClose={feed.previousClose} />
                <QuoteSummary code={code} venue={venue} lastPrice={feed.lastPrice} previousClose={feed.previousClose} upperLimit={bounds.upper} lowerLimit={bounds.lower} />
              </OrderLadder>
            : <EmptyState title={feed.snapshotFailed ? "호가를 불러오지 못했습니다" : "호가를 기다리는 중입니다"} />}
      </div>
      <Strip>
        <b data-testid="order-total-ask" className="mw-down">{view ? formatShares(view.totalAsk) : "-"}</b>
        <RatioBar buy={view?.totalBid ?? 0} sell={view?.totalAsk ?? 0} sellFirst label="총잔량 매도·매수 비율" />
        <Segmented<SessionChoice> label="세션" options={SESSIONS} value={session} onChange={setSession} />
        <b data-testid="order-total-bid" className="mw-up">{view ? formatShares(view.totalBid) : "-"}</b>
      </Strip>
      <div className="od-totals">
        {SIDES.map((side) => {
          const total = sideTotal(data.groups, side);
          return <button key={side} type="button" className="od-total" data-side={side} data-testid={`order-total-${side}`} aria-expanded={listOpen} onClick={() => setListOpen((open) => !open)}>
            {SIDE_LABEL[side]} 접수 <b>{formatShares(total.quantity)}</b> ({total.count}건)
          </button>;
        })}
      </div>
      {listOpen && <OpenOrderList groups={data.groups} writable={writable} onCancel={writes.cancelOne} />}
      <QuantityRow mode={mode} input={input} estimate={estimate} venue={venue} sharePresets={settings.sharePresets} onMode={setMode} onInput={setInput} onVenue={(next) => setVenue(id, next)} />
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
