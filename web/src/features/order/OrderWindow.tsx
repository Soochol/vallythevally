import { useEffect, useMemo, useState } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import type { Venue } from "../../api/generated/Venue";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { WindowId } from "../../layout/kinds";
import { useFundamentals, useSymbolInfo } from "../../api/queries";
import { useOrdersStatus } from "../../api/system";
import { formatPrice } from "../../lib/format";
import { isIndexCode } from "../../lib/symbol";
import { useMockEnvironment } from "../../stores/kiwoomLink";
import { orderVenue, useLayoutStore } from "../../stores/layout";
import { useOrderSettings, useUiStore } from "../../stores/ui";
import { useBookFeed } from "../book/useBookFeed";
import { basePrice, buildLadderRows, gridPrices, type LadderRow } from "../market-window/ladder";
import { RatioBar, Strip } from "../market-window/parts";
import { useLinkedSymbol } from "../market-window/MarketWindowGate";
import { formatShares } from "../market-window/format";
import { infoSlot, tradeSlot } from "../market-window/LadderSlots";
import { useLadderTrades, useQuoteInfo } from "../market-window/useLadderSlots";
import { EmptyState } from "../overlay/State";
import { openSystemSettings } from "../system-settings/open";
import { AccountBand } from "./AccountBand";
import { averageRowPrice, BOOK_NOTICE_TEXT, bookNotice, holdingOf, type ProfitUnit, toggledUnit } from "./holdingSummary";
import { HoldingSummary } from "./HoldingSummary";
import { OrderSettingsPopover } from "./OrderSettingsPopover";
import { tickRuleOf } from "../market-window/tick";
import { fullRangePrices } from "./priceRange";
import { HighValueConfirm, type HighValueRequest } from "./HighValueConfirm";
import { type HoverCell, OrderLadder } from "./OrderLadder";
import { OrderStatusBar } from "./OrderStatusBar";
import { QuantityRow } from "./QuantityRow";
import { capacityProblem, type DragOutcome, needsHighValueConfirm, type PriceGroup, quantityOf, type QuantityMode, SIDE_LABEL, sideTotal } from "./orderRules";
import { useOrderAccess, useOrderData } from "./useOrderData";
import { useOrderWrites } from "./useOrderWrites";

const SIDES: readonly OrderSide[] = ["sell", "buy"];
const EXPLORER_UNAVAILABLE = "상·하한가를 아직 받지 못했습니다";
const CLOCK_MS = 30_000;

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

function useHeldWhile<T>(value: T, hold: boolean): T {
  const [held, setHeld] = useState(value);
  if (!hold && held !== value) setHeld(value);
  return hold ? held : value;
}

function OrderBody({ id, code }: { id: WindowId; code: SymbolCode }) {
  const savedVenue = useLayoutStore((s) => orderVenue(s.layout, id));
  const mock = useMockEnvironment();
  const venue: Venue = mock ? "krx" : savedVenue;
  const setVenue = useLayoutStore((s) => s.setOrderVenue);
  const feed = useBookFeed(code);
  const access = useOrderAccess();
  const [mode, setMode] = useState<QuantityMode>("shares");
  const [input, setInput] = useState("10");
  const [hover, setHover] = useState<HoverCell | null>(null);
  const [confirm, setConfirm] = useState<HighValueRequest | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [centerToken, setCenterToken] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [profitUnit, setProfitUnit] = useState<ProfitUnit>("won");
  const [now, setNow] = useState(() => Date.now());
  const settings = useOrderSettings();
  const setSettings = useUiStore((s) => s.setOrderSettings);
  const limits = useFundamentals(code).data;
  const symbolInfo = useSymbolInfo(code).data;
  const accountTail = useOrdersStatus().data?.accountTail ?? null;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const view = feed.book.phase === "empty" ? null : feed.book.view;
  const bounds = { lower: limits?.lowerLimit ?? null, upper: limits?.upperLimit ?? null };
  const quotes = view ? { asks: view.asks, bids: view.bids, lastPrice: feed.lastPrice, previousClose: feed.previousClose } : null;
  const tickRule = tickRuleOf(symbolInfo?.kind ?? null, view ? [...view.asks, ...view.bids].map((level) => level.price) : []);
  const liveBase = quotes ? basePrice(quotes) : null;
  const gridBase = useHeldWhile(liveBase, dragging);
  const referencePrice = feed.lastPrice ?? feed.previousClose ?? liveBase;
  const fullPrices = useMemo(() => fullRangePrices({ lower: bounds.lower, upper: bounds.upper }, tickRule), [bounds.lower, bounds.upper, tickRule]);
  const explorerOn = exploring && fullPrices !== null;
  const shownRows: LadderRow[] = quotes ? buildLadderRows(explorerOn ? fullPrices : gridPrices(gridBase, bounds, tickRule), quotes) : [];
  const rows = settings.rate ? shownRows : shownRows.map((row) => ({ ...row, rate: null }));
  const notice = view ? bookNotice(Math.floor(now / 1000), symbolInfo ?? null) : null;
  const info = useQuoteInfo({ code, venue, lastPrice: feed.lastPrice, previousClose: feed.previousClose, upperLimit: bounds.upper, lowerLimit: bounds.lower });
  const trades = useLadderTrades(code, venue);
  const data = useOrderData(code, access.open, referencePrice);
  const writes = useOrderWrites(code, venue);
  const holding = holdingOf(data.balance?.holdings ?? [], code);
  const averagePrice = settings.averageDot ? averageRowPrice(rows.map((row) => row.price), holding?.averagePrice ?? null) : null;
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
      <AccountBand accountTail={accountTail} openOrders={data.openOrders} balance={data.balance} executions={data.executions} writable={writable} mock={mock} onCancel={writes.cancelOne} />
      <HoldingSummary holding={holding} buyableAmount={data.capacity.buyableAmount} unit={profitUnit} onUnit={() => setProfitUnit(toggledUnit)} onFill={(fill) => { setMode(fill.mode); setInput(fill.input); }} />
      <div className="od-entry">
        <QuantityRow mode={mode} input={input} estimate={estimate} venue={venue} mock={mock} sharePresets={settings.sharePresets} amountPresets={settings.amountPresets} onMode={setMode} onInput={setInput} onVenue={(next) => setVenue(id, next)} />
        <div className="od-toolbar">
          <button type="button" className="od-tool" data-testid="order-explorer" aria-pressed={explorerOn} disabled={referencePrice === null || fullPrices === null} title={fullPrices === null ? EXPLORER_UNAVAILABLE : undefined} onClick={() => { if (!explorerOn) setCenterToken((token) => token + 1); setExploring(!explorerOn); }}>전체 호가</button>
          <button type="button" className="od-tool" data-testid="order-current" disabled={!explorerOn} onClick={() => setCenterToken((token) => token + 1)}>현재가</button>
          <OrderSettingsPopover settings={settings} holding={holding !== null} onChange={setSettings} />
        </div>
      </div>
      <OrderStatusBar status={writes.status} queued={writes.queued} blocked={data.blocked} onUndo={writes.cancelOne} onReconcile={writes.reconcile} />
      <div className="bk-ladder od-ladder-wrap" data-stale={feed.connected ? undefined : ""} data-exploring={explorerOn ? "" : undefined}>
        {notice && <p className="od-book-notice" data-testid="order-book-notice">{BOOK_NOTICE_TEXT[notice]}</p>}
        {view
            ? <OrderLadder rows={rows} previousClose={feed.previousClose} groups={data.groups} writable={writable} previewQuantity={quantityAt(unitPrice)} hover={hover} onHover={setHover} averagePrice={averagePrice} divider={settings.divider} explorer={explorerOn ? { centerPrice: referencePrice, centerToken } : undefined} onDragging={setDragging} rowSlots={{ topRight: infoSlot(info), bottomLeft: tradeSlot(trades, feed.previousClose) }}
                actions={{ place, drop, cancelOne: writes.cancelOne, cancelAtPrice: writes.cancelAtPrice, cancelGroups: (targets) => targets.forEach((g) => writes.cancelAtPrice(g.side, g.price)) }} />
            : <EmptyState title={feed.snapshotFailed ? "호가를 불러오지 못했습니다" : "호가를 기다리는 중입니다"} />}
      </div>
      <Strip>
        <b data-testid="order-total-ask" className="mw-down">{view ? formatShares(view.totalAsk) : "-"}</b>
        <RatioBar buy={view?.totalBid ?? 0} sell={view?.totalAsk ?? 0} sellFirst label="총잔량 매도·매수 비율" />
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
