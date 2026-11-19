import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { MarginPolicy } from "../../api/generated/MarginPolicy";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import { formatPrice } from "../../lib/format";
import { Popover } from "../overlay/Popover";
import { formatQuantity } from "../market-window/format";
import { formatFillTime, profitText } from "./holdingSummary";
import { fetchAccountNumber } from "./orderApi";
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
  readonly accountTail: string | null;
  readonly maskAccount: boolean;
  readonly openOrders: readonly TradingOpenOrder[];
  readonly balance: TradingBalance | null;
  readonly executions: readonly TradingExecution[];
  readonly writable: boolean;
  readonly mock: boolean;
  readonly policy: MarginPolicy | null;
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
          <span>{formatQuantity(order.openQuantity)}</span>
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
          <span>{formatQuantity(holding.quantity)}</span>
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
          <span>{formatQuantity(fill.quantity)}</span>
        </li>
      ))}
    </ul>
  );
}

const isTab = (target: Node) => target instanceof Element && target.closest(".od-tab") !== null;
const BROKER = "키움";
const ACCOUNT_NUMBER_KEY = ["trading", "account-number"] as const;
const groupedAccountNumber = (digits: string) => `${digits.slice(0, 4)}-${digits.slice(4, 8)}`;

function RevealedAccountLabel({ masked }: { masked: string }) {
  const lookup = useQuery({ queryKey: ACCOUNT_NUMBER_KEY, queryFn: ({ signal }) => fetchAccountNumber(signal), gcTime: 0, staleTime: Infinity, retry: false, refetchOnWindowFocus: false });
  const failure = lookup.isError ? (lookup.error instanceof Error ? lookup.error.message : "계좌번호를 불러오지 못했습니다") : undefined;
  const text = lookup.data ? `${BROKER} ${groupedAccountNumber(lookup.data.accountNumber)}` : masked;
  return <span className="od-account-label" data-testid="account-label" title={failure}>{text}</span>;
}

function AccountLabel({ accountTail, maskAccount }: { accountTail: string | null; maskAccount: boolean }) {
  if (accountTail === null) return <span className="od-account-label" data-testid="account-label">{BROKER} —</span>;
  const masked = `${BROKER} ****-**${accountTail}`;
  if (maskAccount) return <span className="od-account-label" data-testid="account-label">{masked}</span>;
  return <RevealedAccountLabel masked={masked} />;
}

export function AccountBand({ accountTail, maskAccount, openOrders, balance, executions, writable, mock, policy, onCancel }: Props) {
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const counts: Record<PanelKind, number> = { open: openOrders.length, holdings: balance?.holdings.length ?? 0, fills: executions.length };
  const listWindow = listWindowOf(opener.current);
  const label = TABS.find((tab) => tab.kind === panel)?.label;
  return (
    <div className="od-account" data-testid="order-account">
      <div className="od-account-bar">
        <AccountLabel accountTail={accountTail} maskAccount={maskAccount} />
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
          {panel === "open" && <OpenPanel orders={openOrders} writable={writable} onCancel={onCancel} />}
          {panel === "holdings" && <HoldingsPanel balance={balance} />}
          {panel === "fills" && <FillsPanel executions={executions} />}
        </Popover>
      )}
    </div>
  );
}
