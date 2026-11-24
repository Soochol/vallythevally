import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { OrderSide } from "../../api/generated/OrderSide";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import type { Venue } from "../../api/generated/Venue";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { WindowId } from "../../layout/kinds";
import { useFundamentals, useSymbolInfo } from "../../api/queries";
import { formatPrice } from "../../lib/format";
import { isIndexCode } from "../../lib/symbol";
import { createValueStore, useStoreValue } from "../../lib/valueStore";
import { useStableCallback } from "../../lib/useStableCallback";
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
import { EmptyState, ErrorState } from "../overlay/State";
import { isMarketOpen } from "../../chart/time";
import { FeedStrip, useFeedDownSince } from "../market-window/FeedStrip";
import { SymbolHead } from "../market-window/SymbolHead";
import { openSystemSettings } from "../system-settings/open";
import { AccountPart } from "./AccountPart";
import { atLivePrice, averageRowPrice, ETF_ETN_AFTER_HOURS_TEXT, holdingOf, isEtfOrEtnAfterHours, type ProfitUnit, sellOrderQuantity, sellQuantityAtPrice, toggledUnit } from "./holdingSummary";
import { tickRuleOf } from "../market-window/tick";
import { fullRangePrices } from "./priceRange";
import { HighValueConfirm, type HighValueRequest } from "./HighValueConfirm";
import { DragGhost } from "./DragGhost";
import { type HoverCell, type LadderActions, OrderLadder } from "./OrderLadder";
import { orderEntryKey } from "./orderEntries";
import { OrderTotals } from "./OrderTotals";
import { type CancelConfirm, OrderStatusBar } from "./OrderStatusBar";
import { CANCEL_REFUSAL, REJECT_TEXT } from "./statusText";
import { buyBlock, CANCEL_CONFIRM_MS, cancelConfirmText, capacityProblem, type DragOutcome, marginOf, modifyBuyProblem, type DragSource, needsCancelConfirm, needsHighValueConfirm, orderAmount, planCancel, type PriceGroup, type PriceKey, SIDE_LABEL, sendingAt, targetSignature, typedQuantity } from "./orderRules";
import type { PendingWrite } from "./pendingWrites";
import { type PresetKind, routeLabel } from "./orderSettings";
import { withDirectionJosa } from "./josa";
import { pendingWrites } from "./pendingWrites";
import { accountNumberText, FALLBACK_NOTICE, type OrderAccountChoice } from "./orderAccount";
import { useAccountBalance } from "./useAccountBalance";
import { type OrderAccess, useOrderAccess, useOrderData } from "./useOrderData";
import { useOrderAccount } from "./useOrderAccount";
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

function OrderBody({ id, code, infoPager, choice, access, balance }: { id: WindowId; code: SymbolCode; infoPager: InfoPager; choice: OrderAccountChoice; access: OrderAccess; balance: TradingBalance | null }) {
  const mock = useMockEnvironment();
  const quoteVenue = useShownVenue(code);
  const trades = useLadderTrades(code, quoteVenue);
  const feed = useBookFeed(code, quoteVenue, trades.lastTrade);
  const accountRef = choice.current?.ref ?? null;
  const entryKey = useLayoutStore((s) => orderEntryKey(s.layout.id, id, code));
  const [kept] = useState(() => { const { prefs } = useUiStore.getState(); return prefs.orderSettings.keepLastEntry ? prefs.orderEntries[entryKey] ?? null : null; });
  const [presetKind, setPresetKind] = useState<PresetKind>(kept?.presetKind ?? "sharePresets");
  const [input, setInput] = useState(kept === null ? "10" : String(kept.quantity));
  const [hover] = useState(() => createValueStore<HoverCell | null>(null));
  const [confirm, setConfirm] = useState<HighValueRequest | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState<CancelConfirm | null>(null);
  const [exploring, setExploring] = useState(false);
  const ladder = useRef<HTMLDivElement>(null);
  const drag = useOrderDrag(ladder, (source, outcome) => drop(source, outcome));
  const dragging = useStoreValue(drag.views, (view) => view !== null);
  const [profitUnit, setProfitUnit] = useState<ProfitUnit>("won");
  const [now, setNow] = useState(() => Date.now());
  const settings = useOrderSettings();
  const orderVenue: Venue = mock ? "krx" : settings.venue;
  const setSettings = useUiStore((s) => s.setOrderSettings);
  const rememberEntry = useUiStore((s) => s.rememberOrderEntry);
  const limits = useFundamentals(code).data;
  const symbolInfo = useSymbolInfo(code).data;
  const nxtNotTraded = orderVenue === "nxt" && symbolInfo?.nxtEnabled === false;

  useEffect(() => {
    if (cancelConfirm === null) return;
    const timer = setTimeout(() => setCancelConfirm(null), CANCEL_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [cancelConfirm]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const downSince = useFeedDownSince(feed.connected);
  const marketOpen = isMarketOpen(Math.floor(now / 1000));
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
  const expected = view ? visibleExpected(view.t, Math.floor(now / 1000), view.expected) : null;
  const infoSlots = placeInfoItems(rows, info, expectedItemsOnPage(infoPager.page, expected));
  const totals = stripTotals(view && { ask: view.totalAsk, bid: view.totalBid }, visibleAfterHours(feed.afterHours?.totals ?? null, Math.floor(now / 1000)));
  const data = useOrderData(accountRef, code, access.open, referencePrice, balance);

  const pending = useSyncExternalStore(pendingWrites.subscribe, pendingWrites.snapshot);
  const isStale = (shown: CancelConfirm, writesNow: readonly PendingWrite[]): boolean =>
    shown.account !== accountRef || targetSignature(data.groups, shown.targets) !== shown.signature || sendingAt(writesNow, code, shown.targets);
  const cancelConfirmStale = cancelConfirm !== null && isStale(cancelConfirm, pending);
  useEffect(() => {
    if (cancelConfirmStale) setCancelConfirm(null);
  }, [cancelConfirmStale]);
  const confirmCancel = useStableCallback(() => {
    setCancelConfirm(null);
    if (cancelConfirm !== null && !isStale(cancelConfirm, pendingWrites.snapshot())) cancelConfirm.run();
  });
  const writes = useOrderWrites(choice.current, code, orderVenue, id);
  const fellBack = choice.fellBack;
  useEffect(() => {
    if (!fellBack) return;
    writes.say({ tone: "info", text: FALLBACK_NOTICE, fades: true });
    const { prefs } = useUiStore.getState();
    setSettings({ ...prefs.orderSettings, account: null });
  }, [fellBack]);
  const holding = useMemo(() => atLivePrice(holdingOf(data.balance?.holdings ?? [], code), feed.lastPrice), [data.balance, code, feed.lastPrice]);
  const averagePrice = settings.averageDot ? averageRowPrice(rows.map((row) => row.price), holding?.averagePrice ?? null) : null;
  const writable = access.open && !data.blocked && writes.status?.unknown !== true;

  const quantity = typedQuantity(input);

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
      writes.say({ tone: "error", text: block.text, action: block.maxQuantity > 0 ? { label: `${withDirectionJosa(block.maxQuantity)} 보내기`, run: () => latestPlace.current(side, price, block.maxQuantity) } : undefined });
      return;
    }
    submit(side, price, orderQuantity);
  };

  latestPlace.current = place;

  const confirmContext = (route: string) => ({
    name: symbolInfo?.name ?? code,
    code,
    account: accountNumberText(choice.current?.broker ?? "kiwoom", choice.current?.tail ?? null),
    route,
    mock,
  });

  const submit = (side: OrderSide, price: number, quantity: number) => {
    const margin = side === "buy" ? marginOf(orderAmount(price, quantity), data.capacity.buying) : 0;
    const send = (confirmHighValue: boolean) => {
      writes.place({ side, price, quantity, confirmHighValue, margin, listedWhenIn: side === "sell" ? sellQuantityAtPrice(data.groups, pending, code, price, data.openOrdersListedAt) + quantity : 0 });
      if (settings.keepLastEntry) rememberEntry(entryKey, { presetKind, quantity, usedAt: Date.now() });
    };
    if (needsHighValueConfirm(price, quantity)) setConfirm({ ...confirmContext(routeLabel(orderVenue)), side, verb: "주문", detail: `${formatQuantity(quantity)} · ${formatPrice(price, false)}원`, amount: price * quantity, run: () => send(true) });
    else send(false);
  };

  const modifyOrders = (side: OrderSide, price: number, orders: readonly TradingOpenOrder[], to: number) => {
    const problem = side === "buy" ? modifyBuyProblem(price, to, orders.reduce((sum, order) => sum + order.openQuantity, 0), data.capacity.buying) : null;
    if (problem) {
      writes.say({ tone: "error", text: problem });
      return;
    }
    const run = () => writes.modifyAll(orders, to);
    if (orders.some((order) => needsHighValueConfirm(to, order.openQuantity))) setConfirm({ ...confirmContext([...new Set(orders.map((order) => routeLabel(order.venue)))].join("·")), side, verb: "정정", detail: `${formatPrice(price, false)}원 → ${formatPrice(to, false)}원`, amount: to * orders.reduce((sum, order) => sum + order.openQuantity, 0), run });
    else run();
  };

  const currentCancelPlan = (keys: readonly PriceKey[]) => planCancel(data.groups, pendingWrites.snapshot(), code, keys);

  const cancelTargets = (targets: readonly PriceGroup[]) => targets.forEach((group) => writes.cancelAtPrice(group.side, group.price));

  const cancelChecked = (keys: readonly PriceKey[]) => {
    const plan = currentCancelPlan(keys);
    if (plan.kind === "ready") cancelTargets(plan.targets);
    else writes.say(CANCEL_REFUSAL[plan.kind]);
  };

  const cancelMany = (side: OrderSide, keys: readonly PriceKey[]) => {
    const plan = currentCancelPlan(keys);
    if (plan.kind !== "ready") {
      writes.say(CANCEL_REFUSAL[plan.kind]);
      return;
    }
    const run = () => cancelTargets(plan.targets);
    if (needsCancelConfirm(plan.orderCount)) setCancelConfirm({ text: `${SIDE_LABEL[side]} ${cancelConfirmText(plan.orderCount)}`, account: accountRef, targets: plan.targets, signature: plan.signature, run });
    else run();
  };

  const drop = (source: DragSource, outcome: DragOutcome) => {
    if (outcome.kind === "abort") return;
    if (source.kind === "chip") {
      if (outcome.kind === "cancel") cancelMany(source.group.side, [source.group]);
      else modifyOrders(source.group.side, source.group.price, source.group.orders, outcome.price);
    } else if (source.kind === "order") {
      if (outcome.kind === "cancel") writes.cancelOne(source.order.orderNo);
      else modifyOrders(source.order.side, source.order.price, [source.order], outcome.price);
    } else cancelMany(source.side, source.groups);
  };

  const pickAccount = useStableCallback((account: string) => setSettings({ ...settings, account }));
  const toggleProfitUnit = useCallback(() => setProfitUnit(toggledUnit), []);
  const toggleExplorer = useStableCallback(() => setExploring(!explorerOn));
  const placeOrder = useStableCallback(place);
  const cancelOne = useStableCallback(writes.cancelOne);
  const cancelGroups = useStableCallback(cancelChecked);
  const planCancelNow = useStableCallback(currentCancelPlan);
  const ladderActions = useMemo<LadderActions>(() => ({ place: placeOrder, cancelOne, cancelGroups, planCancel: planCancelNow }), []);
  const totalsActions = useMemo(() => ({ cancelOne, cancelGroups, planCancel: planCancelNow }), []);
  const sellOrdered = sellOrderQuantity(data.groups, pending, code, data.openOrdersListedAt);

  return (
    <div className="od" data-testid="order-window" data-symbol={code} data-venue={orderVenue} data-quote-venue={quoteVenue} data-writable={writable ? "" : undefined}>
      {access.reason && (
        <div className="od-gate" role="status" data-testid="order-gate">
          <span>{access.reason}</span>
          <button type="button" className="od-link" onClick={() => openSystemSettings("kiwoom")}>시스템 설정 열기</button>
        </div>
      )}
      <SymbolHead code={code} name={symbolInfo?.name ?? null} lastPrice={feed.lastPrice} previousClose={feed.previousClose} marketOpen={marketOpen} mock={mock} />
      <AccountPart windowId={id} choice={choice} accountRef={accountRef} onPickAccount={pickAccount} openOrders={data.openOrders} balance={data.balance} executions={data.executions} writable={writable} mock={mock} policy={data.orderable?.policy ?? null} onCancel={cancelOne}
        holding={holding} orderable={data.orderable} buyableProblem={data.buyableProblem} sellOrdered={sellOrdered} profitUnit={profitUnit} onProfitUnit={toggleProfitUnit}
        presetKind={presetKind} input={input} referencePrice={referencePrice} onPresetKind={setPresetKind} onInput={setInput}
        settings={settings} orderVenue={orderVenue} nxtNotTraded={nxtNotTraded} onSettings={setSettings} />
      {!feed.connected && <FeedStrip since={downSince} />}
      <div className="bk-ladder od-ladder-wrap" data-stale={feed.connected ? undefined : ""} data-exploring={explorerOn ? "" : undefined}>
        {view
            ? <OrderLadder rows={rows} previousClose={feed.previousClose} groups={data.groups} writable={writable} previewQuantity={quantity} buying={data.capacity.buying} hover={hover} averagePrice={averagePrice} divider={settings.divider} explorerOn={explorerOn} explorerUnavailable={referencePrice === null || fullPrices === null} explorerTitle={fullPrices === null ? EXPLORER_UNAVAILABLE : undefined} onToggleExplorer={toggleExplorer} explorerCenterPrice={explorerOn ? referencePrice : null} ladder={ladder} drag={drag} expectedPrice={expected?.price ?? null} rowSlots={{ infoCard: infoSlot(infoSlots, infoPager), bottomLeft: tradeSlot(trades, feed.previousClose) }} actions={ladderActions} />
            : feed.snapshotFailed ? <ErrorState message="호가를 불러오지 못했습니다" retry={feed.retry} /> : <EmptyState title="호가를 기다리는 중입니다" />}
      </div>
      <OrderTotals groups={data.groups} writable={writable} actions={totalsActions} drag={drag} />
      <Strip>
        <TotalFigure testId="order-total-ask" tone="down" value={totals.ask} afterHours={totals.source === "afterHours"} description={totals.description} hideAfterHoursTag />
        <RatioBar buy={totals.bid ?? 0} sell={totals.ask ?? 0} sellFirst label={totals.description ?? "총잔량 매도·매수 비율"} />
        <TotalFigure testId="order-total-bid" tone="up" value={totals.bid} afterHours={totals.source === "afterHours"} description={totals.description} hideAfterHoursTag />
      </Strip>
      <OrderStatusBar status={writes.status} queued={writes.queued} blocked={data.blocked} confirm={cancelConfirmStale ? null : cancelConfirm} onConfirm={confirmCancel} onUndo={writes.cancelOne} onReconcile={writes.reconcile} onDismiss={writes.dismiss} />
      <DragGhost drag={drag} />
      {confirm && <HighValueConfirm request={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function OrderStockWindow({ id, code, infoPager }: { id: WindowId; code: SymbolCode; infoPager: InfoPager }) {
  const choice = useOrderAccount();
  const access = useOrderAccess(choice);
  const balance = useAccountBalance(choice.current?.ref ?? null, access.open);
  return <OrderBody key={code} id={id} code={code} infoPager={infoPager} choice={choice} access={access} balance={balance} />;
}

export function OrderWindow({ id }: { id: WindowId }) {
  const code = useLinkedSymbol(id);
  const infoPager = useInfoPager();
  if (code === null) return <EmptyState title="연동된 종목이 없습니다" />;
  if (isIndexCode(code)) return <EmptyState title="이 창은 주식만 보입니다" />;
  return <OrderStockWindow id={id} code={code} infoPager={infoPager} />;
}
