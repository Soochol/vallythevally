import { memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import type { WindowId } from "../../layout/kinds";
import { formatPrice } from "../../lib/format";
import { useStableCallback } from "../../lib/useStableCallback";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { formatQuantity } from "../market-window/format";
import { Popover } from "../overlay/Popover";
import { Badge } from "../ui/Badge";
import { keyNewestFirstFills, newestFirst } from "./accountLists";
import { AccountLabel } from "./AccountPicker";
import { formatFillTime } from "./holdingSummary";
import { HoldingRow } from "./HoldingRow";
import { listAnchorRect, listWidthIn, listWindowOf } from "./listPopover";
import type { OrderAccountChoice } from "./orderAccount";
import { SIDE_LABEL } from "./orderRules";
import { type GoToSymbol, SymbolName } from "./SymbolName";

export type AccountPanelKind = "open" | "holdings" | "fills";

const TABS: readonly { readonly kind: AccountPanelKind; readonly label: string; readonly shortLabel: string; readonly miniLabel: string }[] = [
  { kind: "open", label: "미체결 주문", shortLabel: "미체결", miniLabel: "미" },
  { kind: "holdings", label: "보유종목", shortLabel: "보유", miniLabel: "보" },
  { kind: "fills", label: "내 체결", shortLabel: "체결", miniLabel: "체" },
];

interface Props {
  readonly windowId: WindowId;
  readonly symbolCode: SymbolCode;
  readonly symbolName: string | null;
  readonly nxtTraded: boolean;
  readonly choice: OrderAccountChoice;
  readonly onPick: (accountRef: string) => void;
  readonly maskAccount: boolean;
  readonly openOrders: readonly TradingOpenOrder[];
  readonly balance: TradingBalance | null;
  readonly holding: TradingHolding | null;
  readonly executions: readonly TradingExecution[];
  readonly writable: boolean;
  readonly cancelDisabledTitle?: string;
  readonly mock: boolean;
  readonly onCancel: (orderNo: string) => void;
  readonly panel?: AccountPanelKind | null;
  readonly onPanelChange?: (next: AccountPanelKind | null) => void;
  readonly trailing?: ReactNode;
}

type RowsKind = "open" | "holdings" | "fills";

const HEADS: Readonly<Record<RowsKind, readonly string[]>> = {
  open: ["시각", "방향", "종목", "수량", "가격", ""],
  holdings: ["종목", "수량", "평단", "평가손익"],
  fills: ["시각", "방향", "종목", "수량", "가격"],
};

function RowsHead({ kind }: { kind: RowsKind }) {
  return <div className="od-rows-head" data-kind={kind} aria-hidden="true">{HEADS[kind].map((name, index) => <span key={index}>{name}</span>)}</div>;
}

function OpenPanel({ orders, writable, cancelDisabledTitle, onCancel, goTo }: { orders: readonly TradingOpenOrder[]; writable: boolean; cancelDisabledTitle?: string; onCancel(orderNo: string): void; goTo: GoToSymbol }) {
  if (orders.length === 0) return <p className="od-list-empty">미체결 주문이 없습니다</p>;
  return (
    <>
      <RowsHead kind="open" />
      <ul className="od-rows" data-kind="open" data-testid="account-open-orders">
        {orders.map((order) => (
          <li key={order.orderNo} data-side={order.side} data-testid="account-open-order">
            <span className="od-time">{formatFillTime(order.orderedAt)}</span>
            <span className="od-side">{SIDE_LABEL[order.side]}</span>
            <SymbolName code={order.code} name={order.name} goTo={goTo} />
            <span className="od-figure">{formatQuantity(order.openQuantity)}</span>
            <b className="od-figure">{formatPrice(order.price, false)}원</b>
            <button type="button" className="od-row-cancel" disabled={!writable} title={!writable ? cancelDisabledTitle : undefined} onClick={() => onCancel(order.orderNo)}>취소</button>
          </li>
        ))}
      </ul>
    </>
  );
}

function HoldingsPanel({ balance, activeHolding, goTo }: { balance: TradingBalance | null; activeHolding: TradingHolding | null; goTo: GoToSymbol }) {
  const holdings = balance?.holdings ?? [];
  if (holdings.length === 0) return <p className="od-list-empty">보유종목이 없습니다</p>;
  return (
    <>
      <RowsHead kind="holdings" />
      <ul className="od-rows" data-kind="holdings" data-testid="account-holdings">
        {holdings.map((holding) => (
          <HoldingRow key={holding.code} holding={holding} fixed={activeHolding?.code === holding.code ? activeHolding : null} goTo={goTo} />
        ))}
      </ul>
    </>
  );
}

function FillsPanel({
  executions,
  goTo,
}: {
  executions: readonly TradingExecution[];
  goTo: GoToSymbol;
}) {
  const keyedFills = useMemo(() => keyNewestFirstFills(newestFirst(executions)), [executions]);
  if (keyedFills.length === 0) return <p className="od-list-empty">오늘 체결이 없습니다</p>;
  return (
    <>
      <RowsHead kind="fills" />
      <ul className="od-rows" data-kind="fills" data-testid="account-fills">
        {keyedFills.map(({ item: fill, key: rowKey }) => (
          <li key={rowKey} data-side={fill.side} data-testid="account-fill">
            <span className="od-time">{formatFillTime(fill.time)}</span>
            <span className="od-side">{SIDE_LABEL[fill.side]}</span>
            <SymbolName code={fill.code} name={fill.name} goTo={goTo} />
            <span className="od-figure">{formatQuantity(fill.quantity)}</span>
            <b className="od-figure">{formatPrice(fill.price, false)}원</b>
          </li>
        ))}
      </ul>
    </>
  );
}

const isTab = (target: Node) => target instanceof Element && target.closest(".od-tab") !== null;
export const AccountBand = memo(function AccountBand({
  windowId,
  symbolCode,
  symbolName,
  nxtTraded,
  choice,
  onPick,
  maskAccount,
  openOrders,
  balance,
  holding,
  executions,
  writable,
  cancelDisabledTitle,
  mock,
  onCancel,
  panel: controlledPanel,
  onPanelChange,
  trailing,
}: Props) {
  const [localPanel, setLocalPanel] = useState<AccountPanelKind | null>(null);
  const panel = controlledPanel !== undefined ? controlledPanel : localPanel;
  const setPanel = useStableCallback((next: AccountPanelKind | null) => {
    if (onPanelChange) onPanelChange(next);
    else setLocalPanel(next);
  });
  const tabButtons = useRef<Partial<Record<AccountPanelKind, HTMLButtonElement | null>>>({});
  const opener = useRef<HTMLElement | null>(null);
  const [anchorReady, setAnchorReady] = useState(0);
  useLayoutEffect(() => {
    if (panel === null) return;
    const button = tabButtons.current[panel] ?? null;
    if (button !== null && opener.current !== button) {
      opener.current = button;
      setAnchorReady((n) => n + 1);
    }
  }, [panel]);
  const counts: Record<AccountPanelKind, number> = { open: openOrders.length, holdings: balance?.holdings.length ?? 0, fills: executions.length };
  const activeAnchor = panel === null ? null : (tabButtons.current[panel] ?? opener.current);
  const listWindow = listWindowOf(activeAnchor);
  const label = TABS.find((tab) => tab.kind === panel)?.label;

  const goTo: GoToSymbol = useStableCallback((target) => {
    const layout = useLayoutStore.getState();
    const cellId = useSelectionStore.getState().activeCell;
    const win = layout.layout.windows.find((w) => w.id === windowId);
    layout.pinSymbol(windowId, null);
    if (win && win.link !== null) layout.sendSymbol(windowId, cellId, target);
    else layout.setSymbol(cellId, target);
    setPanel(null);
  });

  const closePanel = useStableCallback(() => {
    setPanel(null);
  });

  return (
    <div className="od-account" data-testid="order-account" data-mock={mock ? "" : undefined} data-anchor-ready={anchorReady}>
      <div className="od-account-bar">
        <span className="od-head-inline" data-testid="order-symbol-head">
          <b className="od-head-name" data-testid="order-symbol-name" title={symbolName ?? undefined}>{symbolName ?? symbolCode}</b>
          {nxtTraded && <span className="od-head-nxt" data-testid="order-symbol-nxt"><Badge>NXT</Badge></span>}
        </span>
        <AccountLabel choice={choice} maskAccount={maskAccount} onPick={onPick} />
        {mock && <Badge tone="accent" className="od-env"><span data-testid="account-mock">모의투자</span></Badge>}
        <div className="od-account-tabs">
          {TABS.map(({ kind, label, shortLabel, miniLabel }) => (
            <button
              key={kind}
              ref={(el) => { tabButtons.current[kind] = el; }}
              type="button"
              className="od-tab"
              data-testid={`account-tab-${kind}`}
              aria-label={`${label} ${counts[kind]}`}
              title={`${label} ${counts[kind]}`}
              aria-expanded={panel === kind}
              onClick={(e) => {
                opener.current = e.currentTarget;
                setPanel(panel === kind ? null : kind);
              }}
            >
              <span className="od-tab-full">{label}</span>
              <span className="od-tab-short">{shortLabel}</span>
              <span className="od-tab-mini">{miniLabel}</span>
              {" "}
              <b>{counts[kind]}</b>
            </button>
          ))}
        </div>
        {trailing}
      </div>
      {panel !== null && activeAnchor !== null && (
        <Popover
          solid
          key={panel}
          anchor={opener}
          anchorRect={() => listAnchorRect(tabButtons.current[panel] ?? opener.current)}
          style={listWindow && { width: listWidthIn(listWindow) }}
          releasesClick={isTab}
          onClose={closePanel}
          role="dialog"
          aria-label={label}
          className="od-list-pop"
          data-testid="account-panel"
          data-panel={panel}
        >
          {panel === "open" && <OpenPanel orders={openOrders} writable={writable} cancelDisabledTitle={cancelDisabledTitle} onCancel={onCancel} goTo={goTo} />}
          {panel === "holdings" && <HoldingsPanel balance={balance} activeHolding={holding} goTo={goTo} />}
          {panel === "fills" && <FillsPanel executions={executions} goTo={goTo} />}
        </Popover>
      )}
    </div>
  );
});
