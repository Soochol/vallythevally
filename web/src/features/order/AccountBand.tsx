import { useRef, useState } from "react";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { MarginPolicy } from "../../api/generated/MarginPolicy";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import { formatPrice } from "../../lib/format";
import type { WindowId } from "../../layout/kinds";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { Popover } from "../overlay/Popover";
import { formatQuantity } from "../market-window/format";
import { formatFillTime, profitText } from "./holdingSummary";
import { newestFirst } from "./accountLists";
import { AccountLabel } from "./AccountPicker";
import type { OrderAccountChoice } from "./orderAccount";
import { POLICY_LABEL } from "./funds";
import { listAnchorRect, listWidthIn, listWindowOf } from "./listPopover";
import { SIDE_LABEL } from "./orderRules";

type PanelKind = "open" | "holdings" | "fills";

const TABS: readonly { readonly kind: PanelKind; readonly label: string }[] = [
  { kind: "open", label: "미체결 주문" },
  { kind: "holdings", label: "보유종목" },
  { kind: "fills", label: "내 체결" },
];

interface Props {
  readonly windowId: WindowId;
  readonly choice: OrderAccountChoice;
  readonly onPick: (accountRef: string) => void;
  readonly maskAccount: boolean;
  readonly openOrders: readonly TradingOpenOrder[];
  readonly balance: TradingBalance | null;
  readonly executions: readonly TradingExecution[];
  readonly writable: boolean;
  readonly mock: boolean;
  readonly policy: MarginPolicy | null;
  readonly onCancel: (orderNo: string) => void;
}

type GoTo = (target: { code: string; name: string }) => void;

function SymbolName({ code, name, goTo }: { code: string; name: string; goTo: GoTo }) {
  return <button type="button" className="od-name od-symbol" aria-label={`${name}로 이동`} onClick={() => goTo({ code, name })}>{name}</button>;
}

function OpenPanel({ orders, writable, onCancel, goTo }: { orders: readonly TradingOpenOrder[]; writable: boolean; onCancel(orderNo: string): void; goTo: GoTo }) {
  if (orders.length === 0) return <p className="od-list-empty">미체결 주문이 없습니다</p>;
  return (
    <ul className="od-rows" data-testid="account-open-orders">
      {orders.map((order) => (
        <li key={order.orderNo} data-side={order.side} data-testid="account-open-order">
          <span className="od-side">{SIDE_LABEL[order.side]}</span>
          <SymbolName code={order.code} name={order.name} goTo={goTo} />
          <b>{formatPrice(order.price, false)}원</b>
          <span>{formatQuantity(order.openQuantity)}</span>
          <button type="button" className="od-link" disabled={!writable} onClick={() => onCancel(order.orderNo)}>취소</button>
        </li>
      ))}
    </ul>
  );
}

function HoldingsPanel({ balance, goTo }: { balance: TradingBalance | null; goTo: GoTo }) {
  const holdings = balance?.holdings ?? [];
  if (holdings.length === 0) return <p className="od-list-empty">보유종목이 없습니다</p>;
  return (
    <ul className="od-rows" data-testid="account-holdings">
      {holdings.map((holding) => (
        <li key={holding.code} data-testid="account-holding">
          <SymbolName code={holding.code} name={holding.name} goTo={goTo} />
          <span>{formatQuantity(holding.quantity)}</span>
          <span>평단 {formatPrice(holding.averagePrice, false)}</span>
          <b data-tone={holding.evaluationProfit > 0 ? "up" : holding.evaluationProfit < 0 ? "down" : undefined}>{profitText(holding, "won")}</b>
        </li>
      ))}
    </ul>
  );
}

function FillsPanel({ executions, goTo }: { executions: readonly TradingExecution[]; goTo: GoTo }) {
  if (executions.length === 0) return <p className="od-list-empty">오늘 체결이 없습니다</p>;
  return (
    <ul className="od-rows" data-testid="account-fills">
      {newestFirst(executions).map((fill, index) => (
        <li key={`${fill.orderNo}:${fill.time}:${index}`} data-side={fill.side} data-testid="account-fill">
          <span className="od-time">{formatFillTime(fill.time)}</span>
          <span className="od-side">{SIDE_LABEL[fill.side]}</span>
          <SymbolName code={fill.code} name={fill.name} goTo={goTo} />
          <b>{formatPrice(fill.price, false)}원</b>
          <span>{formatQuantity(fill.quantity)}</span>
        </li>
      ))}
    </ul>
  );
}

const isTab = (target: Node) => target instanceof Element && target.closest(".od-tab") !== null;
export function AccountBand({ windowId, choice, onPick, maskAccount, openOrders, balance, executions, writable, mock, policy, onCancel }: Props) {
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const counts: Record<PanelKind, number> = { open: openOrders.length, holdings: balance?.holdings.length ?? 0, fills: executions.length };
  const listWindow = listWindowOf(opener.current);
  const label = TABS.find((tab) => tab.kind === panel)?.label;
  const goTo: GoTo = (target) => {
    const layout = useLayoutStore.getState();
    layout.pinSymbol(windowId, null);
    layout.sendSymbol(windowId, useSelectionStore.getState().activeCell, target);
    setPanel(null);
  };
  return (
    <div className="od-account" data-testid="order-account">
      <div className="od-account-bar">
        <AccountLabel choice={choice} maskAccount={maskAccount} onPick={onPick} />
        {mock && <span className="od-account-mock" data-testid="account-mock">모의</span>}
        {policy !== null && <span className="od-policy" data-testid="margin-policy" data-policy={policy}>{POLICY_LABEL[policy]}</span>}
        {TABS.map(({ kind, label }) => (
          <button key={kind} type="button" className="od-tab" data-testid={`account-tab-${kind}`} aria-expanded={panel === kind} onClick={(e) => { opener.current = e.currentTarget; setPanel((open) => (open === kind ? null : kind)); }}>
            {label} <b>{counts[kind]}</b>
          </button>
        ))}
      </div>
      {panel !== null && (
        <Popover key={panel} anchor={opener} anchorRect={() => listAnchorRect(opener.current)} style={listWindow && { width: listWidthIn(listWindow) }} releasesClick={isTab} onClose={() => setPanel(null)} role="dialog" aria-label={label} className="od-list-pop" data-testid="account-panel" data-panel={panel}>
          {panel === "open" && <OpenPanel orders={openOrders} writable={writable} onCancel={onCancel} goTo={goTo} />}
          {panel === "holdings" && <HoldingsPanel balance={balance} goTo={goTo} />}
          {panel === "fills" && <FillsPanel executions={executions} goTo={goTo} />}
        </Popover>
      )}
    </div>
  );
}
