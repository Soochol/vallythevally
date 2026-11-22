import { useEffect, useMemo, useRef, useState } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import type { Venue } from "../../api/generated/Venue";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { WindowId } from "../../layout/kinds";
import { useFundamentals, useSymbolInfo } from "../../api/queries";
import { useOrdersStatus } from "../../api/system";
import { formatPrice } from "../../lib/format";
import { isIndexCode } from "../../lib/symbol";
import { useMockEnvironment } from "../../stores/kiwoomLink";
import { useLayoutStore } from "../../stores/layout";
import { useOrderSettings, useUiStore } from "../../stores/ui";
import { useBookFeed } from "../book/useBookFeed";
import { basePrice, buildLadderRows, defaultLadderPrices, type LadderPrices, type LadderRow } from "../market-window/ladder";
import { RatioBar, Strip, TotalFigure } from "../market-window/parts";
import { useLinkedSymbol } from "../market-window/MarketWindowGate";
import { formatQuantity } from "../market-window/format";
import { infoSlot, tradeSlot } from "../market-window/LadderSlots";
import { expectedItemsOnPage, placeInfoItems } from "../market-window/quoteInfo";
import { stripTotals } from "../book/bookModel";
import { visibleAfterHours, visibleExpected } from "../book/sessionWindows";
import { type InfoPager, useInfoPager, useLadderTrades, useQuoteInfo } from "../market-window/useLadderSlots";
import { useShownVenue } from "../market-window/useShownVenue";
import { EmptyState } from "../overlay/State";
import { openSystemSettings } from "../system-settings/open";
import { AccountBand } from "./AccountBand";
import { averageRowPrice, ETF_ETN_AFTER_HOURS_TEXT, holdingOf, isEtfOrEtnAfterHours, type ProfitUnit, sellOrderQuantity, toggledUnit } from "./holdingSummary";
import { HoldingSummary } from "./HoldingSummary";
import { OrderSettingsPopover } from "./OrderSettingsPopover";
import { tickRuleOf } from "../market-window/tick";
import { fullRangePrices } from "./priceRange";
import { HighValueConfirm, type HighValueRequest } from "./HighValueConfirm";
import { DragGhost } from "./DragGhost";
import { type HoverCell, OrderLadder } from "./OrderLadder";
import { orderEntryKey } from "./orderEntries";
import { OrderTotals } from "./OrderTotals";
import { OrderStatusBar } from "./OrderStatusBar";
import { REJECT_TEXT } from "./statusText";
import { OrderEstimate, QuantityRow } from "./QuantityRow";
import { buyBlock, buyPreview, capacityProblem, type DragOutcome, estimateNote, marginOf, modifyBuyProblem, type DragSource, needsHighValueConfirm, orderAmount, SIDE_LABEL, typedQuantity } from "./orderRules";
import type { PresetKind } from "./orderSettings";
import { useOrderAccess, useOrderData } from "./useOrderData";
import { useOrderDrag } from "./useOrderDrag";
import { useOrderWrites } from "./useOrderWrites";

const EXPLORER_UNAVAILABLE = "상·하한가를 아직 받지 못했습니다";
const CLOCK_MS = 30_000;

function useHeldWhile<T>(value: T, hold: boolean, same: (a: T, b: T) => boolean = Object.is): T {
  const [held, setHeld] = useState(value);
  if (!hold && !same(held, value)) setHeld(value);
  return hold ? held : value;
}

const sameLadderPrices = (a: LadderPrices | null, b: LadderPrices | null): boolean =>
  a === b || (a !== null && b !== null && a.sidesSplit === b.sidesSplit && a.prices.length === b.prices.length && a.prices.every((price, row) => price === b.prices[row]));

function OrderBody({ id, code, infoPager }: { id: WindowId; code: SymbolCode; infoPager: InfoPager }) {
  const mock = useMockEnvironment();
  const quoteVenue = useShownVenue(code);
  const feed = useBookFeed(code, quoteVenue);
  const access = useOrderAccess();
  const entryKey = useLayoutStore((s) => orderEntryKey(s.layout.id, id, code));
  const [kept] = useState(() => { const { prefs } = useUiStore.getState(); return prefs.orderSettings.keepLastEntry ? prefs.orderEntries[entryKey] ?? null : null; });
  const [presetKind, setPresetKind] = useState<PresetKind>(kept?.presetKind ?? "sharePresets");
  const [input, setInput] = useState(kept === null ? "10" : String(kept.quantity));
  const [hover, setHover] = useState<HoverCell | null>(null);
  const [confirm, setConfirm] = useState<HighValueRequest | null>(null);
  const [exploring, setExploring] = useState(false);
  const [centerToken, setCenterToken] = useState(0);
  const ladder = useRef<HTMLDivElement>(null);
  const drag = useOrderDrag(ladder, (source, outcome) => drop(source, outcome));
  const dragging = drag.view !== null;
  const [profitUnit, setProfitUnit] = useState<ProfitUnit>("won");
  const [now, setNow] = useState(() => Date.now());
  const settings = useOrderSettings();
  const orderVenue: Venue = mock ? "krx" : settings.venue;
  const setSettings = useUiStore((s) => s.setOrderSettings);
  const rememberEntry = useUiStore((s) => s.rememberOrderEntry);
  const limits = useFundamentals(code).data;
  const symbolInfo = useSymbolInfo(code).data;
  const nxtNotTraded = orderVenue === "nxt" && symbolInfo?.nxtEnabled === false;
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
  const liveLadder = quotes ? defaultLadderPrices({ ...quotes, bounds, tickRule, skipSpreadGap: settings.skipSpreadGap }) : null;
  const heldLadder = useHeldWhile(liveLadder, dragging, sameLadderPrices);
  const referencePrice = feed.lastPrice ?? feed.previousClose ?? liveBase;
  const fullPrices = useMemo(() => fullRangePrices({ lower: bounds.lower, upper: bounds.upper }, tickRule), [bounds.lower, bounds.upper, tickRule]);
  const explorerOn = exploring && fullPrices !== null;
  const shownRows: LadderRow[] = quotes && heldLadder ? (explorerOn ? buildLadderRows(fullPrices, quotes) : buildLadderRows(heldLadder.prices, quotes, heldLadder.sidesSplit)) : [];
  const rows = settings.rate ? shownRows : shownRows.map((row) => ({ ...row, rate: null }));
  const info = useQuoteInfo({ code, venue: quoteVenue, lastPrice: feed.lastPrice, previousClose: feed.previousClose, fundamentals: limits, page: infoPager.page });
  const trades = useLadderTrades(code, quoteVenue);
  const expected = view ? visibleExpected(view.t, Math.floor(now / 1000), view.expected) : null;
  const infoSlots = placeInfoItems(rows, info, expectedItemsOnPage(infoPager.page, expected, feed.previousClose));
  const totals = stripTotals(view && { ask: view.totalAsk, bid: view.totalBid }, visibleAfterHours(feed.afterHours?.totals ?? null, Math.floor(now / 1000)));
  const data = useOrderData(code, access.open, referencePrice);
  const writes = useOrderWrites(code, orderVenue);
  const holding = holdingOf(data.balance?.holdings ?? [], code);
  const averagePrice = settings.averageDot ? averageRowPrice(rows.map((row) => row.price), holding?.averagePrice ?? null) : null;
  const writable = access.open && !data.blocked && writes.status?.unknown !== true;

  const quantity = typedQuantity(input);
  const unitPrice = hover?.price ?? referencePrice ?? 0;
  const estimate = unitPrice > 0 && quantity > 0 ? unitPrice * quantity : null;

  const latestPlace = useRef<(side: OrderSide, price: number, cappedQuantity?: number) => void>(() => undefined);

  const place = (side: OrderSide, price: number, cappedQuantity?: number) => {
    if (nxtNotTraded) {
      writes.say({ tone: "error", text: REJECT_TEXT.nxt_unavailable });
      return;
    }
    if (isEtfOrEtnAfterHours(Math.floor(Date.now() / 1000), symbolInfo ?? null)) {
      writes.say({ tone: "error", text: ETF_ETN_AFTER_HOURS_TEXT });
      return;
    }
    const orderQuantity = cappedQuantity ?? quantity;
    const problem = capacityProblem(side, orderQuantity, data.capacity);
    if (problem) {
      writes.say({ tone: "error", text: problem });
      return;
    }
    const block = side === "buy" ? buyBlock(price, orderQuantity, data.capacity.buying) : null;
    if (block) {
      writes.say({ tone: "error", text: block.text, action: block.maxQuantity > 0 ? { label: `${block.maxQuantity.toLocaleString("ko-KR")}로 보내기`, run: () => latestPlace.current(side, price, block.maxQuantity) } : undefined });
      return;
    }
    submit(side, price, orderQuantity);
  };

  latestPlace.current = place;

  const submit = (side: OrderSide, price: number, quantity: number) => {
    const margin = side === "buy" ? marginOf(orderAmount(price, quantity), data.capacity.buying) : 0;
    const send = (confirmHighValue: boolean) => {
      writes.place({ side, price, quantity, confirmHighValue, margin });
      if (settings.keepLastEntry) rememberEntry(entryKey, { presetKind, quantity, usedAt: Date.now() });
    };
    if (needsHighValueConfirm(price, quantity)) setConfirm({ title: `${SIDE_LABEL[side]} ${formatQuantity(quantity)} · ${formatPrice(price, false)}원`, amount: price * quantity, run: () => send(true) });
    else send(false);
  };

  const modifyOrders = (side: OrderSide, price: number, orders: readonly TradingOpenOrder[], to: number) => {
    const problem = side === "buy" ? modifyBuyProblem(price, to, orders.reduce((sum, order) => sum + order.openQuantity, 0), data.capacity.buying) : null;
    if (problem) {
      writes.say({ tone: "error", text: problem });
      return;
    }
    const run = () => writes.modifyAll(orders, to);
    if (orders.some((order) => needsHighValueConfirm(to, order.openQuantity))) setConfirm({ title: `${SIDE_LABEL[side]} 정정 · ${formatPrice(price, false)}원 → ${formatPrice(to, false)}원`, amount: to * orders.reduce((sum, order) => sum + order.openQuantity, 0), run });
    else run();
  };

  const drop = (source: DragSource, outcome: DragOutcome) => {
    if (outcome.kind === "abort") return;
    if (source.kind === "chip") {
      if (outcome.kind === "cancel") writes.cancelAtPrice(source.group.side, source.group.price);
      else modifyOrders(source.group.side, source.group.price, source.group.orders, outcome.price);
    } else if (source.kind === "order") {
      if (outcome.kind === "cancel") writes.cancelOne(source.order.orderNo);
      else modifyOrders(source.order.side, source.order.price, [source.order], outcome.price);
    } else source.groups.forEach((group) => writes.cancelAtPrice(group.side, group.price));
  };

  return (
    <div className="od" data-testid="order-window" data-symbol={code} data-venue={orderVenue} data-quote-venue={quoteVenue} data-writable={writable ? "" : undefined}>
      {access.reason && (
        <div className="od-gate" role="status" data-testid="order-gate">
          <span>{access.reason}</span>
          <button type="button" className="od-link" onClick={() => openSystemSettings("kiwoom")}>시스템 설정 열기</button>
        </div>
      )}
      <AccountBand windowId={id} accountTail={accountTail} maskAccount={settings.maskAccount} openOrders={data.openOrders} balance={data.balance} executions={data.executions} writable={writable} mock={mock} policy={data.orderable?.policy ?? null} onCancel={writes.cancelOne} />
      <HoldingSummary holding={holding} orderable={data.orderable} buyableProblem={data.buyableProblem} sellOrdered={sellOrderQuantity(data.groups)} unit={profitUnit} onUnit={() => setProfitUnit(toggledUnit)} onFill={setInput} />
      <div className="od-entry">
        <QuantityRow presetKind={presetKind} input={input} sharePresets={settings.sharePresets} amountPresets={settings.amountPresets} referencePrice={referencePrice} keepLastEntry={settings.keepLastEntry} onPresetKind={setPresetKind} onInput={setInput} />
        <div className="od-toolbar">
          <OrderEstimate estimate={estimate} note={estimate !== null && hover?.side !== "sell" ? estimateNote(estimate, data.capacity.buying) : null} />
          <button type="button" className="od-tool" data-testid="order-explorer" aria-pressed={explorerOn} disabled={referencePrice === null || fullPrices === null} title={fullPrices === null ? EXPLORER_UNAVAILABLE : undefined} onClick={() => { if (!explorerOn) setCenterToken((token) => token + 1); setExploring(!explorerOn); }}>전체 호가</button>
          <button type="button" className="od-tool" data-testid="order-current" disabled={!explorerOn} onClick={() => setCenterToken((token) => token + 1)}>현재가</button>
          <OrderSettingsPopover settings={settings} venue={orderVenue} mock={mock} nxtNotTraded={nxtNotTraded} holding={holding !== null} onChange={setSettings} />
        </div>
      </div>
      <div className="bk-ladder od-ladder-wrap" data-stale={feed.connected ? undefined : ""} data-exploring={explorerOn ? "" : undefined}>
        {view
            ? <OrderLadder rows={rows} previousClose={feed.previousClose} groups={data.groups} writable={writable} previewQuantity={quantity} buyPreview={(price) => buyPreview(price, quantity, data.capacity.buying)} hover={hover} onHover={setHover} averagePrice={averagePrice} divider={settings.divider} explorer={explorerOn ? { centerPrice: referencePrice, centerToken } : undefined} ladder={ladder} drag={drag} expectedPrice={expected?.price ?? null} rowSlots={{ topRight: infoSlot(infoSlots, infoPager, rows), bottomLeft: tradeSlot(trades, feed.previousClose) }}
                actions={{ place, cancelOne: writes.cancelOne, cancelAtPrice: writes.cancelAtPrice, cancelGroups: (targets) => targets.forEach((g) => writes.cancelAtPrice(g.side, g.price)) }} />
            : <EmptyState title={feed.snapshotFailed ? "호가를 불러오지 못했습니다" : "호가를 기다리는 중입니다"} />}
        <OrderStatusBar status={writes.status} queued={writes.queued} blocked={data.blocked} onUndo={writes.cancelOne} onReconcile={writes.reconcile} onDismiss={writes.dismiss} />
      </div>
      <OrderTotals groups={data.groups} writable={writable} actions={writes} drag={drag} />
      <Strip>
        <TotalFigure testId="order-total-ask" tone="down" value={totals.ask} afterHours={totals.source === "afterHours"} description={totals.description} />
        <RatioBar buy={totals.bid ?? 0} sell={totals.ask ?? 0} sellFirst label={totals.description ?? "총잔량 매도·매수 비율"} />
        <TotalFigure testId="order-total-bid" tone="up" value={totals.bid} afterHours={totals.source === "afterHours"} description={totals.description} />
      </Strip>
      {drag.view && <DragGhost view={drag.view} />}
      {confirm && <HighValueConfirm request={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

export function OrderWindow({ id }: { id: WindowId }) {
  const code = useLinkedSymbol(id);
  const infoPager = useInfoPager();
  if (code === null) return <EmptyState title="연동된 종목이 없습니다" />;
  if (isIndexCode(code)) return <EmptyState title="이 창은 주식만 보입니다" />;
  return <OrderBody key={code} id={id} code={code} infoPager={infoPager} />;
}
