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
import { serverNow, useServerClock } from "../../stores/serverClock";
import { useOrderSettings, useUiStore } from "../../stores/ui";
import { useSymbolVi } from "../../stores/symbolVi";
import { useBookFeed } from "../book/useBookFeed";
import { ReplayStrip } from "../book-replay/ReplayStrip";
import { replayReference } from "../book-replay/replay";
import { useBookReplay, useBookReplayEnabled } from "../book-replay/useBookReplay";
import { basePrice, buildLadderRows, defaultLadderPrices, type LadderPrices, type LadderRow } from "../market-window/ladder";
import { RatioBar, Strip, TotalFigure } from "../market-window/parts";
import { useLinkedSymbol } from "../market-window/MarketWindowGate";
import { formatQuantity } from "../market-window/format";
import { infoSlot, replayTradeSlot, tradeSlot } from "../market-window/LadderSlots";
import { expectedItemsOnPage, placeInfoItems } from "../market-window/quoteInfo";
import { stripTotals } from "../book/bookModel";
import { isRegularSession, visibleAfterHours, visibleExpected } from "../book/sessionWindows";
import { type InfoPager, useInfoPager, useLadderTrades, useQuoteInfo } from "../market-window/useLadderSlots";
import { useShownVenue } from "../market-window/useShownVenue";
import { EmptyState, ErrorState } from "../overlay/State";
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
import { OrderStatusBar } from "./OrderStatusBar";
import { CANCEL_REFUSAL, REJECT_TEXT, REPLAY_LOCKED_TEXT } from "./statusText";
import { buyBlock, capacityProblem, type DragOutcome, marginOf, modifyBuyProblem, type DragSource, needsHighValueConfirm, orderAmount, planCancel, type PriceKey, typedQuantity } from "./orderRules";
import { routeLabel } from "./orderSettings";
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
const DEFAULT_ORDER_QUANTITY = 10;

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
  const replayEnabled = useBookReplayEnabled();
  const replay = useBookReplay(code);
  const replayLocked = replay.kind !== "live";
  const replayLockedRef = useRef(replayLocked);
  replayLockedRef.current = replayLocked;
  const accountRef = choice.current?.ref ?? null;
  const entryKey = useLayoutStore((s) => orderEntryKey(s.layout.id, id, code));
  const [kept] = useState(() => { const { prefs } = useUiStore.getState(); return prefs.orderSettings.keepLastEntry ? prefs.orderEntries[entryKey] ?? null : null; });
  const [input, setInput] = useState(kept === null ? String(DEFAULT_ORDER_QUANTITY) : String(kept.quantity));
  const [hover] = useState(() => createValueStore<HoverCell | null>(null));
  const [confirm, setConfirm] = useState<HighValueRequest | null>(null);
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
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const downSince = useFeedDownSince(feed.connected);
  const vi = useSymbolVi(code, "krx");
  const nowSeconds = Math.floor(now / 1000);
  const liveView = feed.book.phase === "empty" ? null : feed.book.view;
  const bounds = { lower: limits?.lowerLimit ?? null, upper: limits?.upperLimit ?? null };
  const serverNowSeconds = Math.floor(serverNow(useServerClock.getState().serverTimeOrigin) / 1000);
  const replayRef = replay.kind === "past" ? replayReference(replay.at, serverNowSeconds, { previousClose: feed.previousClose, bounds }) : null;
  const replayPreviousClose = replayRef?.previousClose ?? null;
  const replayLower = replayRef?.bounds.lower ?? null;
  const replayUpper = replayRef?.bounds.upper ?? null;
  const symbolKind = symbolInfo?.kind ?? null;
  const quotes = liveView ? { asks: liveView.asks, bids: liveView.bids, lastPrice: feed.lastPrice, previousClose: feed.previousClose } : null;
  const tickRule = tickRuleOf(symbolKind, liveView ? [...liveView.asks, ...liveView.bids].map((level) => level.price) : []);
  const liveBase = quotes ? basePrice(quotes) : null;
  const liveLadder = quotes ? defaultLadderPrices({ ...quotes, bounds, tickRule, skipSpreadGap: settings.skipSpreadGap }) : null;
  const heldLadder = useHeldWhile(liveLadder, dragging, sameLadderPrices);
  const referencePrice = feed.lastPrice ?? feed.previousClose ?? liveBase;
  const fullPrices = useMemo(() => fullRangePrices({ lower: bounds.lower, upper: bounds.upper }, tickRule), [bounds.lower, bounds.upper, tickRule]);
  const explorerOn = !replayLocked && exploring && fullPrices !== null;
  const pastRows = useMemo<LadderRow[]>(() => {
    if (replay.kind !== "past") return [];
    const pastQuotes = { asks: replay.book.asks, bids: replay.book.bids, lastPrice: replay.lastPrice, previousClose: replayPreviousClose };
    const pastTickRule = tickRuleOf(symbolKind, [...replay.book.asks, ...replay.book.bids].map((level) => level.price));
    const pastLadder = defaultLadderPrices({ ...pastQuotes, bounds: { lower: replayLower, upper: replayUpper }, tickRule: pastTickRule, skipSpreadGap: settings.skipSpreadGap });
    return buildLadderRows(pastLadder.prices, pastQuotes, pastLadder.sidesSplit);
  }, [replay, replayPreviousClose, replayLower, replayUpper, settings.skipSpreadGap, symbolKind]);
  const pastRowSlots = useMemo(
    () => (replay.kind === "past" ? { bottomLeft: replayTradeSlot(replay.trades, replayPreviousClose) } : undefined),
    [replay, replayPreviousClose],
  );
  const liveRows: LadderRow[] = replay.kind === "live" && quotes && heldLadder ? (explorerOn ? buildLadderRows(fullPrices, quotes) : buildLadderRows(heldLadder.prices, quotes, heldLadder.sidesSplit)) : [];
  const rows = replay.kind === "past" ? pastRows : liveRows;
  const info = useQuoteInfo({ code, venue: quoteVenue, lastPrice: feed.lastPrice, previousClose: feed.previousClose, fundamentals: limits, page: infoPager.page, flipped: infoPager.flipped, sameTimeRatio: trades.sameTimeRatio, vi, tickRule, regularSession: isRegularSession(nowSeconds), now: nowSeconds });
  const expected = replay.kind === "live" && liveView ? visibleExpected(liveView.t, nowSeconds, liveView.expected, vi) : null;
  const infoSlots = replay.kind === "live" ? placeInfoItems(rows, info, expectedItemsOnPage(infoPager.page, expected, feed.previousClose, infoPager.flipped)) : [];
  const liveTotals = stripTotals(liveView && { ask: liveView.totalAsk, bid: liveView.totalBid }, visibleAfterHours(feed.afterHours?.totals ?? null, nowSeconds));
  const totals = replay.kind === "live"
    ? liveTotals
    : replay.kind === "past"
      ? { ask: replay.book.totalAsk, bid: replay.book.totalBid, source: "regular" as const, description: null }
      : { ask: null, bid: null, source: "regular" as const, description: null };
  const data = useOrderData(accountRef, code, access.open, referencePrice, balance);

  const pending = useSyncExternalStore(pendingWrites.subscribe, pendingWrites.snapshot);
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
  const notifyReplayLocked = () => writes.say({ tone: "error", text: REPLAY_LOCKED_TEXT });

  const place = (side: OrderSide, price: number, cappedQuantity?: number) => {
    if (replayLockedRef.current) {
      notifyReplayLocked();
      return;
    }
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
      if (replayLockedRef.current) {
        notifyReplayLocked();
        return;
      }
      writes.place({ side, price, quantity, confirmHighValue, margin, listedWhenIn: side === "sell" ? sellQuantityAtPrice(data.groups, pending, code, price, data.openOrdersListedAt) + quantity : 0 });
      if (settings.keepLastEntry) rememberEntry(entryKey, { quantity, usedAt: Date.now() });
    };
    if (needsHighValueConfirm(price, quantity)) setConfirm({ ...confirmContext(routeLabel(orderVenue)), side, verb: "주문", detail: `${formatQuantity(quantity)} · ${formatPrice(price, false)}원`, amount: price * quantity, run: () => send(true) });
    else send(false);
  };

  const modifyOrders = (side: OrderSide, price: number, orders: readonly TradingOpenOrder[], to: number) => {
    if (replayLockedRef.current) {
      notifyReplayLocked();
      return;
    }
    const problem = side === "buy" ? modifyBuyProblem(price, to, orders.reduce((sum, order) => sum + order.openQuantity, 0), data.capacity.buying) : null;
    if (problem) {
      writes.say({ tone: "error", text: problem });
      return;
    }
    const run = () => {
      if (replayLockedRef.current) {
        notifyReplayLocked();
        return;
      }
      writes.modifyAll(orders, to);
    };
    if (orders.some((order) => needsHighValueConfirm(to, order.openQuantity))) setConfirm({ ...confirmContext([...new Set(orders.map((order) => routeLabel(order.venue)))].join("·")), side, verb: "정정", detail: `${formatPrice(price, false)}원 → ${formatPrice(to, false)}원`, amount: to * orders.reduce((sum, order) => sum + order.openQuantity, 0), run });
    else run();
  };

  const cancelChecked = (keys: readonly PriceKey[]) => {
    const plan = planCancel(data.groups, pendingWrites.snapshot(), code, keys);
    if (plan.kind === "ready") plan.targets.forEach((group) => writes.cancelAtPrice(group.side, group.price));
    else writes.say(CANCEL_REFUSAL[plan.kind]);
  };

  const drop = (source: DragSource, outcome: DragOutcome) => {
    if (outcome.kind === "abort") return;
    if (source.kind === "chip") {
      if (replayLockedRef.current) {
        notifyReplayLocked();
        return;
      }
      if (outcome.kind === "cancel") cancelChecked([source.group]);
      else modifyOrders(source.group.side, source.group.price, source.group.orders, outcome.price);
    } else if (source.kind === "order") {
      if (outcome.kind === "cancel") writes.cancelOne(source.order.orderNo);
      else if (replayLockedRef.current) notifyReplayLocked();
      else modifyOrders(source.order.side, source.order.price, [source.order], outcome.price);
    } else cancelChecked(source.groups);
  };

  const pickAccount = useStableCallback((account: string) => setSettings({ ...settings, account }));
  const changeInput = useStableCallback((nextInput: string) => {
    setInput(nextInput);
    if (!useUiStore.getState().prefs.orderSettings.keepLastEntry) return;
    const nextQuantity = typedQuantity(nextInput);
    if (nextQuantity > 0) rememberEntry(entryKey, { quantity: nextQuantity, usedAt: Date.now() });
  });
  const toggleProfitUnit = useCallback(() => setProfitUnit(toggledUnit), []);
  const toggleExplorer = useStableCallback(() => {
    if (replayLockedRef.current) return;
    setExploring((was) => !was);
  });
  const placeOrder = useStableCallback(place);
  const cancelOne = useStableCallback(writes.cancelOne);
  const cancelGroups = useStableCallback(cancelChecked);
  const cancelLadderOne = useStableCallback((orderNo: string) => {
    if (replayLockedRef.current) {
      notifyReplayLocked();
      return;
    }
    writes.cancelOne(orderNo);
  });
  const cancelLadderGroups = useStableCallback((keys: readonly PriceKey[]) => {
    if (replayLockedRef.current) {
      notifyReplayLocked();
      return;
    }
    cancelChecked(keys);
  });
  const ladderActions = useMemo<LadderActions>(() => ({ place: placeOrder, cancelOne: cancelLadderOne, cancelGroups: cancelLadderGroups }), []);
  const totalsActions = useMemo(() => ({ cancelOne, cancelGroups }), []);
  const sellOrdered = sellOrderQuantity(data.groups, pending, code, data.openOrdersListedAt);
  const headPrice = replay.kind === "live" ? feed.lastPrice : replay.kind === "past" ? replay.lastPrice : null;
  const headPreviousClose = replay.kind === "live" ? feed.previousClose : replayPreviousClose;
  const shownLadder = replay.kind === "past" || (replay.kind === "live" && liveView !== null);

  return (
    <div className="od" data-testid="order-window" data-symbol={code} data-venue={orderVenue} data-quote-venue={quoteVenue} data-writable={writable ? "" : undefined} data-rate-hidden={settings.rate ? undefined : ""} data-replay={replay.kind === "live" ? undefined : replay.kind}>
      {access.reason && (
        <div className="od-gate" role="status" data-testid="order-gate">
          <span>{access.reason}</span>
          <button type="button" className="od-link" onClick={() => openSystemSettings("kiwoom")}>시스템 설정 열기</button>
        </div>
      )}
      <SymbolHead code={code} name={symbolInfo?.name ?? null} lastPrice={headPrice} previousClose={headPreviousClose} nxtTraded={symbolInfo?.nxtEnabled === true} nxtLabel="NXT지원" mock={mock} />
      {replayEnabled && <ReplayStrip view={replay}><span className="od-replay-lock">주문 잠금</span></ReplayStrip>}
      <AccountPart windowId={id} choice={choice} accountRef={accountRef} onPickAccount={pickAccount} openOrders={data.openOrders} balance={data.balance} executions={data.executions} writable={writable} mock={mock} policy={data.orderable?.policy ?? null} onCancel={cancelOne}
        holding={holding} orderable={data.orderable} buyableProblem={data.buyableProblem} sellOrdered={sellOrdered} profitUnit={profitUnit} onProfitUnit={toggleProfitUnit}
        input={input} referencePrice={referencePrice} onInput={changeInput}
        settings={settings} orderVenue={orderVenue} nxtNotTraded={nxtNotTraded} onSettings={setSettings} />
      {replay.kind === "live" && !feed.connected && <FeedStrip since={downSince} />}
      <div className="bk-ladder od-ladder-wrap" data-stale={replay.kind === "live" && !feed.connected ? "" : undefined} data-exploring={explorerOn ? "" : undefined} data-state={shownLadder ? undefined : ""}>
        {replay.kind === "none" ? (
          <EmptyState title={replay.reason} />
        ) : shownLadder ? (
          <OrderLadder rows={rows} previousClose={headPreviousClose} groups={data.groups} writable={writable && !replayLocked} previewQuantity={quantity} buying={data.capacity.buying} hover={hover} averagePrice={averagePrice} divider={settings.divider} rateShown={settings.rate} explorerOn={explorerOn} explorerUnavailable={replayLocked || referencePrice === null || fullPrices === null} explorerTitle={replayLocked ? undefined : fullPrices === null ? EXPLORER_UNAVAILABLE : undefined} onToggleExplorer={toggleExplorer} explorerCenterPrice={explorerOn ? referencePrice : null} ladder={ladder} drag={drag} expectedPrice={expected?.price ?? null} rowSlots={replay.kind === "past" ? pastRowSlots : { infoCard: infoSlot(infoSlots, infoPager), bottomLeft: tradeSlot(trades, feed.previousClose) }} actions={ladderActions} />
        ) : feed.snapshotFailed ? (
          <ErrorState message="호가를 불러오지 못했습니다" retry={feed.retry} />
        ) : (
          <EmptyState title="호가를 기다리는 중입니다" />
        )}
      </div>
      <OrderTotals groups={data.groups} writable={writable} actions={totalsActions} drag={drag} />
      <Strip>
        <TotalFigure testId="order-total-ask" tone="down" value={totals.ask} afterHours={totals.source === "afterHours"} description={totals.description} hideAfterHoursTag />
        <RatioBar buy={totals.bid ?? 0} sell={totals.ask ?? 0} sellFirst label={totals.description ?? "총잔량 매도·매수 비율"} />
        <TotalFigure testId="order-total-bid" tone="up" value={totals.bid} afterHours={totals.source === "afterHours"} description={totals.description} hideAfterHoursTag />
      </Strip>
      <OrderStatusBar status={writes.status} queued={writes.queued} blocked={data.blocked} onUndo={writes.cancelOne} onReconcile={writes.reconcile} onDismiss={writes.dismiss} />
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
