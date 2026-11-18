import { useState } from "react";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import { formatPrice } from "../../lib/format";
import { formatShares } from "../market-window/format";
import { formatFillTime, profitText } from "./holdingSummary";
import { SIDE_LABEL } from "./orderRules";

type PanelKind = "open" | "holdings" | "fills";

const TABS: readonly { readonly kind: PanelKind; readonly label: string }[] = [
  { kind: "open", label: "미체결 주문" },
  { kind: "holdings", label: "보유종목" },
  { kind: "fills", label: "내 체결" },
];

interface Props {
  readonly accountTail: string | null;
  readonly openOrders: readonly TradingOpenOrder[];
  readonly balance: TradingBalance | null;
  readonly executions: readonly TradingExecution[];
  readonly writable: boolean;
  readonly onCancel: (orderNo: string) => void;
}

function OpenPanel({ orders, writable, onCancel }: { orders: readonly TradingOpenOrder[]; writable: boolean; onCancel(orderNo: string): void }) {
  if (orders.length === 0) return <p className="od-list-empty">미체결 주문이 없습니다</p>;
  return (
    <ul className="od-rows" data-testid="account-open-orders">
      {orders.map((order) => (
        <li key={order.orderNo} data-side={order.side} data-testid="account-open-order">
          <span className="od-side">{SIDE_LABEL[order.side]}</span>
          <span className="od-name">{order.name}</span>
          <b>{formatPrice(order.price, false)}원</b>
          <span>{formatShares(order.openQuantity)}</span>
          <button type="button" className="od-link" disabled={!writable} onClick={() => onCancel(order.orderNo)}>취소</button>
        </li>
      ))}
    </ul>
  );
}

function HoldingsPanel({ balance }: { balance: TradingBalance | null }) {
  const holdings = balance?.holdings ?? [];
  if (holdings.length === 0) return <p className="od-list-empty">보유종목이 없습니다</p>;
  return (
    <ul className="od-rows" data-testid="account-holdings">
      {holdings.map((holding) => (
        <li key={holding.code} data-testid="account-holding">
          <span className="od-name">{holding.name}</span>
          <span>{formatShares(holding.quantity)}</span>
          <span>평단 {formatPrice(holding.averagePrice, false)}</span>
          <b data-tone={holding.evaluationProfit > 0 ? "up" : holding.evaluationProfit < 0 ? "down" : undefined}>{profitText(holding, "won")}</b>
        </li>
      ))}
    </ul>
  );
}

function FillsPanel({ executions }: { executions: readonly TradingExecution[] }) {
  if (executions.length === 0) return <p className="od-list-empty">오늘 체결이 없습니다</p>;
  return (
    <ul className="od-rows" data-testid="account-fills">
      {executions.map((fill, index) => (
        <li key={`${fill.orderNo}:${fill.time}:${index}`} data-side={fill.side} data-testid="account-fill">
          <span className="od-time">{formatFillTime(fill.time)}</span>
          <span className="od-side">{SIDE_LABEL[fill.side]}</span>
          <span className="od-name">{fill.name}</span>
          <b>{formatPrice(fill.price, false)}원</b>
          <span>{formatShares(fill.quantity)}</span>
        </li>
      ))}
    </ul>
  );
}

export function AccountBand({ accountTail, openOrders, balance, executions, writable, onCancel }: Props) {
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const counts: Record<PanelKind, number> = { open: openOrders.length, holdings: balance?.holdings.length ?? 0, fills: executions.length };
  return (
    <div className="od-account" data-testid="order-account">
      <div className="od-account-bar">
        <span className="od-account-label" data-testid="account-label">계좌 {accountTail === null ? "—" : `··${accountTail}`}</span>
        {TABS.map(({ kind, label }) => (
          <button key={kind} type="button" className="od-tab" data-testid={`account-tab-${kind}`} aria-expanded={panel === kind} onClick={() => setPanel((open) => (open === kind ? null : kind))}>
            {label} <b>{counts[kind]}</b>
          </button>
        ))}
      </div>
      {panel !== null && (
        <div className="od-account-panel" data-testid="account-panel" data-panel={panel}>
          {panel === "open" && <OpenPanel orders={openOrders} writable={writable} onCancel={onCancel} />}
          {panel === "holdings" && <HoldingsPanel balance={balance} />}
          {panel === "fills" && <FillsPanel executions={executions} />}
        </div>
      )}
    </div>
  );
}
