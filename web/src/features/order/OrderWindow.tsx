import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { Venue } from "../../api/generated/Venue";
import type { WindowId } from "../../layout/kinds";
import { isIndexCode } from "../../lib/symbol";
import { useStableCallback } from "../../lib/useStableCallback";
import { createValueStore, useStoreValue } from "../../lib/valueStore";
import { useMockEnvironment } from "../../stores/kiwoomLink";
import { useLayoutStore } from "../../stores/layout";
import { useOrderSettings, useUiStore } from "../../stores/ui";
import { useViSession } from "../../stores/viSession";
import { FeedStrip } from "../market-window/FeedStrip";
import { basePrice, buildLadderRows, defaultLadderPrices, type LadderPrices, type LadderRow } from "../market-window/ladder";
import { infoSlot, replayTradeSlot, tradeSlot } from "../market-window/LadderSlots";
import { useLinkedSymbol } from "../market-window/MarketWindowGate";
import { FooterRatioBar, TotalFigure, TotalRatioToggle } from "../market-window/parts";
import { expectedItemsOnPage, placeInfoItems } from "../market-window/quoteInfo";
import { type InfoPager, useInfoPager, useLadderMarket } from "../market-window/useLadderMarket";
import { EmptyState, ErrorState } from "../overlay/State";
import { openSystemSettings } from "../system-settings/open";
import { AccountBand, type AccountPanelKind } from "./AccountBand";
import { DragGhost } from "./DragGhost";
import { HighValueConfirm } from "./HighValueConfirm";
import { atLivePrice, averageRowPrice, holdingOf, type ProfitUnit, remainingToSell, sellOrderQuantity, toggledUnit } from "./holdingSummary";
import { HoldingSummary } from "./HoldingSummary";
import { FALLBACK_NOTICE, type OrderAccountChoice } from "./orderAccount";
import { orderEntryKey } from "./orderEntries";
import { type HoverCell, type LadderActions, OrderLadder } from "./OrderLadder";
import { typedQuantity } from "./orderRules";
import { ladderRowHeightPx, type PresetMode } from "./orderSettings";
import { OrderSettingsPopover } from "./OrderSettingsPopover";
import { OrderStatusBar } from "./OrderStatusBar";
import { OrderTotalCell } from "./OrderTotals";
import { fullRangePrices } from "./priceRange";
import { QuantityRow } from "./QuantityRow";
import { useAccountBalance } from "./useAccountBalance";
import { useOrderAccount } from "./useOrderAccount";
import { useOrderCommands } from "./useOrderCommands";
import { type OrderAccess, useOrderAccess, useOrderData } from "./useOrderData";
import { useOrderDrag } from "./useOrderDrag";
import { useOrderWrites } from "./useOrderWrites";
import { ViOrderOverlay } from "./ViOrderOverlay";

const EXPLORER_UNAVAILABLE = "상·하한가를 아직 받지 못했습니다";
const DEFAULT_ORDER_QUANTITY = 10;

function useHeldWhile<T>(value: T, hold: boolean, same: (a: T, b: T) => boolean = Object.is): T {
  const [held, setHeld] = useState(value);
  if (!hold && !same(held, value)) setHeld(value);
  return hold ? held : value;
}

const sameLadderPrices = (a: LadderPrices | null, b: LadderPrices | null): boolean =>
  a === b || (a !== null && b !== null && a.sidesSplit === b.sidesSplit && a.prices.length === b.prices.length && a.prices.every((price, row) => price === b.prices[row]));

function OrderBody({
  id,
  code,
  infoPager,
  choice,
  access,
  balance,
  accountPanel,
  onAccountPanelChange,
  selectedFillKey,
  onSelectFillKey,
}: {
  id: WindowId;
  code: SymbolCode;
  infoPager: InfoPager;
  choice: OrderAccountChoice;
  access: OrderAccess;
  balance: TradingBalance | null;
  accountPanel: AccountPanelKind | null;
  onAccountPanelChange: (next: AccountPanelKind | null) => void;
  selectedFillKey: string | null;
  onSelectFillKey: (next: string | null) => void;
}) {
  const mock = useMockEnvironment();
  const settings = useOrderSettings();
  const orderVenue: Venue = mock ? "krx" : settings.venue;
  const setSettings = useUiStore((s) => s.setOrderSettings);
  const rememberEntry = useUiStore((s) => s.rememberOrderEntry);
  const market = useLadderMarket(code, infoPager, settings.skipSpreadGap);
  const { feed, replay, replayLocked, liveView, liveQuotes, bounds, tickRule, totals, trades, symbolInfo } = market;
  const accountRef = choice.current?.ref ?? null;
  const entryKey = useLayoutStore((s) => orderEntryKey(s.layout.id, id, code));
  const [kept] = useState(() => { const { prefs } = useUiStore.getState(); return prefs.orderSettings.keepLastEntry ? prefs.orderEntries[entryKey] ?? null : null; });
  const [input, setInput] = useState(kept === null ? String(DEFAULT_ORDER_QUANTITY) : String(kept.quantity));
  const [buyFull, setBuyFull] = useState(false);
  const [hover] = useState(() => createValueStore<HoverCell | null>(null));
  const [exploring, setExploring] = useState(false);
  const [profitUnit, setProfitUnit] = useState<ProfitUnit>("won");
  const ladder = useRef<HTMLDivElement>(null);
  const nxtNotTraded = orderVenue === "nxt" && symbolInfo?.nxtEnabled === false;

  const liveBase = liveQuotes ? basePrice(liveQuotes) : null;
  const liveLadder = liveQuotes ? defaultLadderPrices({ ...liveQuotes, bounds, tickRule, skipSpreadGap: settings.skipSpreadGap }) : null;
  const referencePrice = feed.lastPrice ?? feed.previousClose ?? liveBase;
  const fullPrices = useMemo(() => fullRangePrices(bounds, tickRule), [bounds.lower, bounds.upper, tickRule]);
  const explorerOn = !replayLocked && exploring && fullPrices !== null;

  const data = useOrderData(accountRef, code, access.open, referencePrice, balance);
  const writes = useOrderWrites(choice.current, code, orderVenue, id);
  const fellBack = choice.fellBack;
  useEffect(() => {
    if (!fellBack) return;
    writes.say({ tone: "info", text: FALLBACK_NOTICE, fades: true });
    const { prefs } = useUiStore.getState();
    setSettings({ ...prefs.orderSettings, account: null });
  }, [fellBack]);

  const holding = useMemo(() => atLivePrice(holdingOf(data.balance?.holdings ?? [], code), feed.lastPrice), [data.balance, code, feed.lastPrice]);
  const writable = access.open && !data.blocked && writes.status?.unknown !== true;
  const quantity = typedQuantity(input);
  const buyFullActive = buyFull && settings.presetMode === "buy";

  const commands = useOrderCommands(
    {
      code,
      symbolInfo,
      currentAccount: choice.current,
      orderVenue,
      mock,
      nxtNotTraded,
      replayLocked,
      quantity,
      buyFull: buyFullActive,
      keepLastEntry: settings.keepLastEntry,
      capacity: data.capacity,
      groups: data.groups,
      openOrdersListedAt: data.openOrdersListedAt,
    },
    writes,
    (nextQuantity, usedAt) => rememberEntry(entryKey, { quantity: nextQuantity, usedAt }),
  );

  const drag = useOrderDrag(ladder, (source, outcome) => commands.drop(source, outcome));
  const dragging = useStoreValue(drag.views, (view) => view !== null);
  const heldLadder = useHeldWhile(liveLadder, dragging, sameLadderPrices);

  const liveRows: LadderRow[] =
    replay.kind === "live" && liveQuotes && heldLadder
      ? explorerOn
        ? buildLadderRows(fullPrices, liveQuotes)
        : buildLadderRows(heldLadder.prices, liveQuotes, heldLadder.sidesSplit)
      : [];
  const rows = replay.kind === "past" ? market.pastRows : liveRows;
  const pastRowSlots = useMemo(
    () => (replay.kind === "past" ? { bottomLeft: replayTradeSlot(replay.trades, market.headPreviousClose) } : undefined),
    [replay, market.headPreviousClose],
  );
  const infoSlots = replay.kind === "live" ? placeInfoItems(rows, market.info, expectedItemsOnPage(infoPager.page, market.expected, feed.previousClose, infoPager.flipped)) : [];
  const averagePrice = settings.averageDot ? averageRowPrice(rows.map((row) => row.price), holding?.averagePrice ?? null) : null;

  const pickAccount = useStableCallback((account: string) => setSettings({ ...settings, account }));
  const changePresetMode = useStableCallback((presetMode: PresetMode) => {
    setBuyFull(false);
    const { prefs } = useUiStore.getState();
    setSettings({ ...prefs.orderSettings, presetMode });
  });
  const applyInput = useStableCallback((nextInput: string, nextBuyFull: boolean) => {
    setBuyFull(nextBuyFull);
    setInput(nextInput);
    if (!useUiStore.getState().prefs.orderSettings.keepLastEntry) return;
    const nextQuantity = typedQuantity(nextInput);
    if (nextQuantity > 0) rememberEntry(entryKey, { quantity: nextQuantity, usedAt: Date.now() });
  });
  const changeInput = useStableCallback((nextInput: string) => applyInput(nextInput, false));
  const toggleProfitUnit = useCallback(() => setProfitUnit(toggledUnit), []);
  const toggleExplorer = useStableCallback(() => {
    if (replayLocked) return;
    setExploring((was) => !was);
  });

  const ladderActions = useMemo<LadderActions>(
    () => ({ place: commands.place, cancelOne: commands.cancelLadderOne, cancelGroups: commands.cancelLadderGroups }),
    [commands.place, commands.cancelLadderOne, commands.cancelLadderGroups],
  );
  const totalsActions = useMemo(
    () => ({ cancelOne: commands.cancelOne, cancelGroups: commands.cancelGroups }),
    [commands.cancelOne, commands.cancelGroups],
  );
  const hasHolding = holding !== null;
  const settingsPopover = useMemo(
    () => <OrderSettingsPopover settings={settings} venue={orderVenue} mock={mock} nxtNotTraded={nxtNotTraded} holding={hasHolding} onChange={setSettings} />,
    [settings, orderVenue, mock, nxtNotTraded, hasHolding, setSettings],
  );
  const sellOrdered = sellOrderQuantity(data.groups, data.pending, code, data.openOrdersListedAt);
  const sellableRemaining = holding === null ? null : Math.max(0, remainingToSell(holding, sellOrdered));
  const shownLadder = replay.kind === "past" || (replay.kind === "live" && liveView !== null);
  const viState = useViSession(code, market.activeVi, market.expected, replay.kind === "live", !explorerOn && shownLadder, market.liveView?.t ?? null, true);

  const rowHeightPx = ladderRowHeightPx(settings.ladderDensity);

  return (
    <div className="od" data-testid="order-window" data-symbol={code} data-venue={orderVenue} data-quote-venue={market.venue} data-writable={writable ? "" : undefined} data-rate-hidden={settings.rate ? undefined : ""} data-ladder-density={settings.ladderDensity} data-replay={replay.kind === "live" ? undefined : replay.kind}>
      {access.reason && (
        <div className="od-gate" role="status" data-testid="order-gate">
          <span>{access.reason}</span>
          <button type="button" className="od-link" onClick={() => openSystemSettings("kiwoom")}>시스템 설정 열기</button>
        </div>
      )}
      <AccountBand
        windowId={id}
        symbolCode={code}
        symbolName={symbolInfo?.name ?? null}
        nxtTraded={symbolInfo?.nxtEnabled === true}
        choice={choice}
        onPick={pickAccount}
        maskAccount={settings.maskAccount}
        openOrders={data.openOrders}
        balance={data.balance}
        holding={holding}
        executions={data.executions}
        ordersOpen={access.open}
        writable={writable}
        mock={mock}
        onCancel={commands.cancelOne}
        panel={accountPanel}
        onPanelChange={onAccountPanelChange}
        selectedFillKey={selectedFillKey}
        onSelectFillKey={onSelectFillKey}
        trailing={settingsPopover}
      />
      <HoldingSummary account={accountRef} holding={holding} orderable={data.orderable} buyableProblem={data.buyableProblem} sellOrdered={sellOrdered} unit={profitUnit} onUnit={toggleProfitUnit} onFill={changeInput} />
      <QuantityRow
        input={input}
        mode={settings.presetMode}
        amountPresets={settings.amountPresets}
        referencePrice={referencePrice}
        buying={data.capacity.buying}
        sellableRemaining={sellableRemaining}
        hasHolding={hasHolding}
        onMode={changePresetMode}
        onInput={changeInput}
        onPreset={applyInput}
      />
      {replay.kind === "live" && !feed.connected && <FeedStrip since={market.downSince} />}
      <div className="bk-ladder od-ladder-wrap" data-stale={replay.kind === "live" && !feed.connected ? "" : undefined} data-exploring={explorerOn ? "" : undefined} data-state={shownLadder ? undefined : ""}>
        <ViOrderOverlay band="top" state={viState} previousClose={market.headPreviousClose} />
        {replay.kind === "none" ? (
          <EmptyState title={replay.reason} />
        ) : shownLadder ? (
          <OrderLadder rows={rows} previousClose={market.headPreviousClose} groups={data.groups} writable={writable && !replayLocked} previewQuantity={quantity} buyFull={buyFullActive} buying={data.capacity.buying} hover={hover} averagePrice={averagePrice} dayPrices={replay.kind === "live" ? feed.dayPrices : null} divider={settings.divider} rateShown={settings.rate} rowHeightPx={rowHeightPx} explorerOn={explorerOn} explorerUnavailable={replayLocked || referencePrice === null || fullPrices === null} explorerTitle={replayLocked ? undefined : fullPrices === null ? EXPLORER_UNAVAILABLE : undefined} onToggleExplorer={toggleExplorer} explorerCenterPrice={explorerOn ? referencePrice : null} ladder={ladder} drag={drag} expectedPrice={market.expected?.price ?? null} rowSlots={replay.kind === "past" ? pastRowSlots : { infoCard: infoSlot(infoSlots, infoPager), bottomLeft: tradeSlot(trades, feed.previousClose) }} actions={ladderActions} />
        ) : feed.snapshotFailed ? (
          <ErrorState message="호가를 불러오지 못했습니다" retry={feed.retry} />
        ) : (
          <EmptyState title="호가를 기다리는 중입니다" />
        )}
        <ViOrderOverlay band="bottom" state={viState} previousClose={market.headPreviousClose} />
      </div>
      <div className="od-footer" data-testid="order-totals">
        <FooterRatioBar ask={totals.ask} bid={totals.bid} />
        <div className="od-footer-side">
          <OrderTotalCell side="sell" groups={data.groups} writable={writable} actions={totalsActions} drag={drag} />
          <TotalFigure testId="order-total-ask" tone="down" value={totals.ask} afterHours={totals.source === "afterHours"} description={totals.description} hideAfterHoursTag />
        </div>
        <TotalRatioToggle ask={totals.ask} bid={totals.bid} />
        <div className="od-footer-side">
          <TotalFigure testId="order-total-bid" tone="up" value={totals.bid} afterHours={totals.source === "afterHours"} description={totals.description} hideAfterHoursTag />
          <OrderTotalCell side="buy" groups={data.groups} writable={writable} actions={totalsActions} drag={drag} />
        </div>
      </div>
      <OrderStatusBar status={writes.status} queued={writes.queued} blocked={data.blocked} replay={market.replayEnabled ? replay : null} onUndo={writes.cancelOne} onReconcile={writes.reconcile} onDismiss={writes.dismiss} />
      <DragGhost drag={drag} />
      {commands.confirm && <HighValueConfirm request={commands.confirm} onClose={commands.clearConfirm} />}
    </div>
  );
}

function OrderStockWindow({ id, code, infoPager }: { id: WindowId; code: SymbolCode; infoPager: InfoPager }) {
  const choice = useOrderAccount();
  const access = useOrderAccess(choice);
  const balance = useAccountBalance(choice.current?.ref ?? null, access.open);
  const [accountPanel, setAccountPanel] = useState<AccountPanelKind | null>(null);
  const [selectedFillKey, setSelectedFillKey] = useState<string | null>(null);
  return (
    <OrderBody
      key={code}
      id={id}
      code={code}
      infoPager={infoPager}
      choice={choice}
      access={access}
      balance={balance}
      accountPanel={accountPanel}
      onAccountPanelChange={setAccountPanel}
      selectedFillKey={selectedFillKey}
      onSelectFillKey={setSelectedFillKey}
    />
  );
}

export function OrderWindow({ id }: { id: WindowId }) {
  const code = useLinkedSymbol(id);
  const infoPager = useInfoPager();
  if (code === null) return <EmptyState title="연동된 종목이 없습니다" />;
  if (isIndexCode(code)) return <EmptyState title="이 창은 주식만 보입니다" />;
  return <OrderStockWindow id={id} code={code} infoPager={infoPager} />;
}
