import { memo, useRef, useState } from "react";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import type { MarginPolicy } from "../../api/generated/MarginPolicy";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import { formatPrice } from "../../lib/format";
import { useStableCallback } from "../../lib/useStableCallback";
import type { WindowId } from "../../layout/kinds";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { Popover } from "../overlay/Popover";
import { Badge } from "../ui/Badge";
import type { Venue } from "../../api/generated/Venue";
import { routeLabel } from "./orderSettings";
import { formatQuantity } from "../market-window/format";
import { formatFillTime } from "./holdingSummary";
import { HoldingRow } from "./HoldingRow";
import { type GoToSymbol, SymbolName } from "./SymbolName";
import { newestFirst } from "./accountLists";
import { AccountLabel } from "./AccountPicker";
import type { OrderAccountChoice } from "./orderAccount";
import { POLICY_LABEL } from "./funds";
import { listAnchorRect, listWidthIn, listWindowOf } from "./listPopover";
import { SIDE_LABEL } from "./orderRules";

type PanelKind = "open" | "holdings" | "fills";

const TABS: readonly { readonly kind: PanelKind; readonly label: string; readonly shortLabel?: string }[] = [
  { kind: "open", label: "미체결 주문", shortLabel: "미체결" },
  { kind: "holdings", label: "보유종목" },
  { kind: "fills", label: "내 체결", shortLabel: "체결" },
];

interface Props {
  readonly windowId: WindowId;
  readonly choice: OrderAccountChoice;
  readonly onPick: (accountRef: string) => void;
  readonly maskAccount: boolean;
  readonly openOrders: readonly TradingOpenOrder[];
  readonly balance: TradingBalance | null;
  readonly holding: TradingHolding | null;
  readonly executions: readonly TradingExecution[];
  readonly writable: boolean;
  readonly mock: boolean;
  readonly venue: Venue;
  readonly policy: MarginPolicy | null;
  readonly onCancel: (orderNo: string) => void;
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

function OpenPanel({ orders, writable, onCancel, goTo }: { orders: readonly TradingOpenOrder[]; writable: boolean; onCancel(orderNo: string): void; goTo: GoToSymbol }) {
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
            <button type="button" className="od-row-cancel" disabled={!writable} onClick={() => onCancel(order.orderNo)}>취소</button>
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

function FillsPanel({ executions, goTo }: { executions: readonly TradingExecution[]; goTo: GoToSymbol }) {
  if (executions.length === 0) return <p className="od-list-empty">오늘 체결이 없습니다</p>;
  return (
    <>
      <RowsHead kind="fills" />
      <ul className="od-rows" data-kind="fills" data-testid="account-fills">
        {newestFirst(executions).map((fill, index) => (
          <li key={`${fill.orderNo}:${fill.time}:${index}`} data-side={fill.side} data-testid="account-fill">
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
export const AccountBand = memo(function AccountBand({ windowId, choice, onPick, maskAccount, openOrders, balance, holding, executions, writable, mock, venue, policy, onCancel }: Props) {
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const counts: Record<PanelKind, number> = { open: openOrders.length, holdings: balance?.holdings.length ?? 0, fills: executions.length };
  const listWindow = listWindowOf(opener.current);
  const label = TABS.find((tab) => tab.kind === panel)?.label;
  const goTo: GoToSymbol = useStableCallback((target) => {
    const layout = useLayoutStore.getState();
    layout.pinSymbol(windowId, null);
    layout.sendSymbol(windowId, useSelectionStore.getState().activeCell, target);
    setPanel(null);
  });
  return (
    <div className="od-account" data-testid="order-account">
      <div className="od-account-bar">
        <div className="od-account-head">
          <AccountLabel choice={choice} maskAccount={maskAccount} onPick={onPick} />
          {mock && <Badge tone="accent" className="od-env"><span data-testid="account-mock">모의투자</span></Badge>}
          <span className="od-route" data-testid="account-route" title="주문 경로">{routeLabel(venue)}</span>
          {policy !== null && <Badge tone={policy === "allow_margin" ? "warning" : "success"} className="od-policy"><span data-testid="margin-policy" data-policy={policy}>{POLICY_LABEL[policy]}</span></Badge>}
        </div>
        <div className="od-account-tabs">
          {TABS.map(({ kind, label, shortLabel }) => (
            <button key={kind} type="button" className="od-tab" data-testid={`account-tab-${kind}`} aria-expanded={panel === kind} onClick={(e) => { opener.current = e.currentTarget; setPanel((open) => (open === kind ? null : kind)); }}>
              {shortLabel === undefined ? label : (
                <>
                  <span className="od-tab-full">{label}</span>
                  <span className="od-tab-short">{shortLabel}</span>
                </>
              )}
              {" "}
              <b>{counts[kind]}</b>
            </button>
          ))}
        </div>
      </div>
      {panel !== null && (
        <Popover solid key={panel} anchor={opener} anchorRect={() => listAnchorRect(opener.current)} style={listWindow && { width: listWidthIn(listWindow) }} releasesClick={isTab} onClose={() => setPanel(null)} role="dialog" aria-label={label} className="od-list-pop" data-testid="account-panel" data-panel={panel}>
          {panel === "open" && <OpenPanel orders={openOrders} writable={writable} onCancel={onCancel} goTo={goTo} />}
          {panel === "holdings" && <HoldingsPanel balance={balance} activeHolding={holding} goTo={goTo} />}
          {panel === "fills" && <FillsPanel executions={executions} goTo={goTo} />}
        </Popover>
      )}
    </div>
  );
});
