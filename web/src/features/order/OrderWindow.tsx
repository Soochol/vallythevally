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
import { useOrderSettings, useUiStore } from "../../stores/ui";
import { useBookFeed } from "../book/useBookFeed";
import { basePrice, buildLadderRows, defaultLadderPrices, type LadderPrices, type LadderRow } from "../market-window/ladder";
import { RatioBar, Strip, TotalFigure } from "../market-window/parts";
import { useLinkedSymbol } from "../market-window/MarketWindowGate";
import { formatQuantity } from "../market-window/format";
import { infoSlot, tradeSlot } from "../market-window/LadderSlots";
import { expectedInfoItems, placeInfoItems } from "../market-window/quoteInfo";
import { stripTotals } from "../book/bookModel";
import { visibleAfterHours, visibleExpected } from "../book/sessionWindows";
import { useLadderTrades, useQuoteInfo } from "../market-window/useLadderSlots";
import { EmptyState } from "../overlay/State";
import { openSystemSettings } from "../system-settings/open";
import { AccountBand } from "./AccountBand";
import { averageRowPrice, ETF_ETN_AFTER_HOURS_TEXT, holdingOf, isEtfOrEtnAfterHours, type ProfitUnit, toggledUnit } from "./holdingSummary";
import { HoldingSummary } from "./HoldingSummary";
import { OrderSettingsPopover } from "./OrderSettingsPopover";
import { tickRuleOf } from "../market-window/tick";
import { fullRangePrices } from "./priceRange";
import { HighValueConfirm, type HighValueRequest } from "./HighValueConfirm";
import { type HoverCell, OrderLadder } from "./OrderLadder";
import { OrderTotals } from "./OrderTotals";
import { OrderStatusBar } from "./OrderStatusBar";
import { REJECT_TEXT } from "./statusText";
import { OrderEstimate, QuantityRow } from "./QuantityRow";
import { capacityProblem, type DragOutcome, needsHighValueConfirm, type PriceGroup, quantityOf, type QuantityMode, SIDE_LABEL } from "./orderRules";
import { useOrderAccess, useOrderData } from "./useOrderData";
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

function OrderBody({ code }: { code: SymbolCode }) {
  const mock = useMockEnvironment();
  const feed = useBookFeed(code);
  const access = useOrderAccess();
  const [mode, setMode] = useState<QuantityMode>("shares");
  const [input, setInput] = useState("10");
  const [hover, setHover] = useState<HoverCell | null>(null);
  const [confirm, setConfirm] = useState<HighValueRequest | null>(null);
  const [exploring, setExploring] = useState(false);
  const [centerToken, setCenterToken] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [profitUnit, setProfitUnit] = useState<ProfitUnit>("won");
  const [now, setNow] = useState(() => Date.now());
  const settings = useOrderSettings();
  const venue: Venue = mock ? "krx" : settings.venue;
  const setSettings = useUiStore((s) => s.setOrderSettings);
  const limits = useFundamentals(code).data;
  const symbolInfo = useSymbolInfo(code).data;
  const nxtNotTraded = venue === "nxt" && symbolInfo?.nxtEnabled === false;
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
  const liveLadder = quotes ? defaultLadderPrices({ ...quotes, bounds, tickRule }) : null;
  const heldLadder = useHeldWhile(liveLadder, dragging, sameLadderPrices);
  const referencePrice = feed.lastPrice ?? feed.previousClose ?? liveBase;
  const fullPrices = useMemo(() => fullRangePrices({ lower: bounds.lower, upper: bounds.upper }, tickRule), [bounds.lower, bounds.upper, tickRule]);
  const explorerOn = exploring && fullPrices !== null;
  const shownRows: LadderRow[] = quotes && heldLadder ? (explorerOn ? buildLadderRows(fullPrices, quotes) : buildLadderRows(heldLadder.prices, quotes, heldLadder.sidesSplit)) : [];
  const rows = settings.rate ? shownRows : shownRows.map((row) => ({ ...row, rate: null }));
  const info = useQuoteInfo({ code, venue, lastPrice: feed.lastPrice, previousClose: feed.previousClose, upperLimit: bounds.upper, lowerLimit: bounds.lower });
  const trades = useLadderTrades(code, venue);
  const expected = view ? visibleExpected(view.t, Math.floor(now / 1000), view.expected) : null;
  const infoSlots = placeInfoItems(rows, info, expected === null ? [] : expectedInfoItems(expected, feed.previousClose));
  const totals = stripTotals(view && { ask: view.totalAsk, bid: view.totalBid }, visibleAfterHours(feed.afterHours?.totals ?? null, Math.floor(now / 1000)));
  const data = useOrderData(code, access.open, referencePrice);
  const writes = useOrderWrites(code, venue);
  const holding = holdingOf(data.balance?.holdings ?? [], code);
  const averagePrice = settings.averageDot ? averageRowPrice(rows.map((row) => row.price), holding?.averagePrice ?? null) : null;
  const writable = access.open && !data.blocked && writes.status?.unknown !== true;

  const typed = Number(input);
  const unitPrice = hover?.price ?? referencePrice ?? 0;
  const quantityAt = (price: number) => quantityOf(mode, typed, price);
  const estimate = unitPrice > 0 && quantityAt(unitPrice) > 0 ? unitPrice * quantityAt(unitPrice) : null;

  const place = (side: OrderSide, price: number) => {
    if (nxtNotTraded) {
      writes.say({ tone: "error", text: REJECT_TEXT.nxt_unavailable });
      return;
    }
    if (isEtfOrEtnAfterHours(Math.floor(Date.now() / 1000), symbolInfo ?? null)) {
      writes.say({ tone: "error", text: ETF_ETN_AFTER_HOURS_TEXT });
      return;
    }
    const quantity = quantityAt(price);
    const problem = capacityProblem(side, price, quantity, data.capacity);
    if (problem) {
      writes.say({ tone: "error", text: problem });
      return;
    }
    const send = (confirmHighValue: boolean) => writes.place({ side, price, quantity, confirmHighValue });
    if (needsHighValueConfirm(price, quantity)) setConfirm({ title: `${SIDE_LABEL[side]} ${formatQuantity(quantity)} · ${formatPrice(price, false)}원`, amount: price * quantity, run: () => send(true) });
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
      <HoldingSummary holding={holding} buyableAmount={data.capacity.buyableAmount} buyableProblem={data.buyableProblem} unit={profitUnit} onUnit={() => setProfitUnit(toggledUnit)} onFill={(fill) => { setMode(fill.mode); setInput(fill.input); }} />
      <div className="od-entry">
        <QuantityRow mode={mode} input={input} sharePresets={settings.sharePresets} amountPresets={settings.amountPresets} onMode={setMode} onInput={setInput} />
        <div className="od-toolbar">
          <OrderEstimate estimate={estimate} />
          <button type="button" className="od-tool" data-testid="order-explorer" aria-pressed={explorerOn} disabled={referencePrice === null || fullPrices === null} title={fullPrices === null ? EXPLORER_UNAVAILABLE : undefined} onClick={() => { if (!explorerOn) setCenterToken((token) => token + 1); setExploring(!explorerOn); }}>전체 호가</button>
          <button type="button" className="od-tool" data-testid="order-current" disabled={!explorerOn} onClick={() => setCenterToken((token) => token + 1)}>현재가</button>
          <OrderSettingsPopover settings={settings} venue={venue} mock={mock} nxtNotTraded={nxtNotTraded} holding={holding !== null} onChange={setSettings} />
        </div>
      </div>
      <div className="bk-ladder od-ladder-wrap" data-stale={feed.connected ? undefined : ""} data-exploring={explorerOn ? "" : undefined}>
        {view
            ? <OrderLadder rows={rows} previousClose={feed.previousClose} groups={data.groups} writable={writable} previewQuantity={quantityAt(unitPrice)} hover={hover} onHover={setHover} averagePrice={averagePrice} divider={settings.divider} explorer={explorerOn ? { centerPrice: referencePrice, centerToken } : undefined} onDragging={setDragging} expectedPrice={expected?.price ?? null} rowSlots={{ topRight: infoSlot(infoSlots), bottomLeft: tradeSlot(trades, feed.previousClose) }}
                actions={{ place, drop, cancelOne: writes.cancelOne, cancelAtPrice: writes.cancelAtPrice, cancelGroups: (targets) => targets.forEach((g) => writes.cancelAtPrice(g.side, g.price)) }} />
            : <EmptyState title={feed.snapshotFailed ? "호가를 불러오지 못했습니다" : "호가를 기다리는 중입니다"} />}
        <OrderStatusBar status={writes.status} queued={writes.queued} blocked={data.blocked} onUndo={writes.cancelOne} onReconcile={writes.reconcile} onDismiss={writes.dismiss} />
      </div>
      <OrderTotals groups={data.groups} writable={writable} actions={writes} />
      <Strip>
        <TotalFigure testId="order-total-ask" tone="down" value={totals.ask} afterHours={totals.source === "afterHours"} description={totals.description} />
        <RatioBar buy={totals.bid ?? 0} sell={totals.ask ?? 0} sellFirst label={totals.description ?? "총잔량 매도·매수 비율"} />
        <TotalFigure testId="order-total-bid" tone="up" value={totals.bid} afterHours={totals.source === "afterHours"} description={totals.description} />
      </Strip>
      {confirm && <HighValueConfirm request={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

export function OrderWindow({ id }: { id: WindowId }) {
  const code = useLinkedSymbol(id);
  if (code === null) return <EmptyState title="연동된 종목이 없습니다" />;
  if (isIndexCode(code)) return <EmptyState title="이 창은 주식만 보입니다" />;
  return <OrderBody key={code} code={code} />;
}
