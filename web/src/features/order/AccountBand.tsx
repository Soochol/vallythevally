import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ExecutionForensic } from "../../api/generated/ExecutionForensic";
import type { MarginPolicy } from "../../api/generated/MarginPolicy";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import type { Venue } from "../../api/generated/Venue";
import { useExecutionForensics } from "../../api/trading";
import type { WindowId } from "../../layout/kinds";
import { formatPrice } from "../../lib/format";
import { useStableCallback } from "../../lib/useStableCallback";
import { useChartPointerStore } from "../../stores/chartPointer";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { formatQuantity } from "../market-window/format";
import { Popover } from "../overlay/Popover";
import { Badge } from "../ui/Badge";
import { newestFirst } from "./accountLists";
import { AccountLabel } from "./AccountPicker";
import { DIAGNOSIS_LABEL, ExecutionForensicCard } from "./ExecutionForensicCard";
import { POLICY_LABEL } from "./funds";
import { formatFillTime } from "./holdingSummary";
import { HoldingRow } from "./HoldingRow";
import { listAnchorRect, listWidthIn, listWindowOf } from "./listPopover";
import type { OrderAccountChoice } from "./orderAccount";
import { SIDE_LABEL } from "./orderRules";
import { routeLabel } from "./orderSettings";
import { type GoToSymbol, SymbolName } from "./SymbolName";

export type AccountPanelKind = "open" | "holdings" | "fills";

const TABS: readonly { readonly kind: AccountPanelKind; readonly label: string; readonly shortLabel?: string }[] = [
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
  readonly panel?: AccountPanelKind | null;
  readonly onPanelChange?: (next: AccountPanelKind | null) => void;
  readonly selectedFillKey?: string | null;
  readonly onSelectFillKey?: (next: string | null) => void;
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

function fillRowKey(fill: TradingExecution, index: number): string {
  return `${fill.orderNo}:${fill.time}:${fill.price}:${index}`;
}

function matchForensic(
  fill: TradingExecution,
  exactMap: ReadonlyMap<string, ExecutionForensic>,
  byOrderNo: ReadonlyMap<string, ExecutionForensic>,
): ExecutionForensic | undefined {
  return exactMap.get(`${fill.orderNo}:${fill.time}:${fill.price}`) ?? byOrderNo.get(fill.orderNo);
}

function FillsPanel({
  executions,
  forensics,
  selectedKey,
  onSelect,
  goTo,
}: {
  executions: readonly TradingExecution[];
  forensics: readonly ExecutionForensic[];
  selectedKey: string | null;
  onSelect: (rowKey: string, fill: TradingExecution, forensic: ExecutionForensic | undefined) => void;
  goTo: GoToSymbol;
}) {
  const ordered = useMemo(() => newestFirst(executions), [executions]);
  const { exactMap, byOrderNo } = useMemo(() => {
    const exact = new Map<string, ExecutionForensic>();
    const fallback = new Map<string, ExecutionForensic>();
    for (const item of forensics) {
      const exactKey = `${item.orderNo}:${item.time}:${item.price}`;
      if (!exact.has(exactKey)) exact.set(exactKey, item);
      if (!fallback.has(item.orderNo)) fallback.set(item.orderNo, item);
    }
    return { exactMap: exact, byOrderNo: fallback };
  }, [forensics]);

  const selectedForensic = useMemo(() => {
    if (selectedKey === null) return undefined;
    for (let index = 0; index < ordered.length; index++) {
      const fill = ordered[index]!;
      if (fillRowKey(fill, index) === selectedKey) {
        return matchForensic(fill, exactMap, byOrderNo);
      }
    }
    return undefined;
  }, [ordered, selectedKey, exactMap, byOrderNo]);

  if (ordered.length === 0) return <p className="od-list-empty">오늘 체결이 없습니다</p>;
  return (
    <>
      <RowsHead kind="fills" />
      <ul className="od-rows" data-kind="fills" data-testid="account-fills">
        {ordered.map((fill, index) => {
          const rowKey = fillRowKey(fill, index);
          const forensic = matchForensic(fill, exactMap, byOrderNo);
          const isSelected = selectedKey === rowKey;
          return (
            <li
              key={rowKey}
              data-side={fill.side}
              data-testid="account-fill"
              data-selected={isSelected ? "" : undefined}
              onClick={() => onSelect(rowKey, fill, forensic)}
            >
              <div className="od-fill-main">
                <span className="od-time">{formatFillTime(fill.time)}</span>
                <span className="od-side">{SIDE_LABEL[fill.side]}</span>
                <span className="od-fill-symbol" onClick={(e) => e.stopPropagation()}>
                  <SymbolName code={fill.code} name={fill.name} goTo={goTo} />
                </span>
                <span className="od-figure">{formatQuantity(fill.quantity)}</span>
                <b className="od-figure">{formatPrice(fill.price, false)}원</b>
              </div>
              {forensic !== undefined && (
                <div className="od-fill-diag">
                  <span
                    className="od-forensic-badge"
                    data-testid="fill-diagnosis-badge"
                    data-diagnosis={forensic.diagnosis}
                  >
                    {forensic.collected ? DIAGNOSIS_LABEL[forensic.diagnosis] : "미수집"}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {selectedForensic !== undefined && <ExecutionForensicCard item={selectedForensic} />}
    </>
  );
}

const isTab = (target: Node) => target instanceof Element && target.closest(".od-tab") !== null;
export const AccountBand = memo(function AccountBand({
  windowId,
  choice,
  onPick,
  maskAccount,
  openOrders,
  balance,
  holding,
  executions,
  writable,
  mock,
  venue,
  policy,
  onCancel,
  panel: controlledPanel,
  onPanelChange,
  selectedFillKey: controlledSelectedFillKey,
  onSelectFillKey,
}: Props) {
  const [localPanel, setLocalPanel] = useState<AccountPanelKind | null>(null);
  const [localSelectedFillKey, setLocalSelectedFillKey] = useState<string | null>(null);
  const panel = controlledPanel !== undefined ? controlledPanel : localPanel;
  const selectedFillKey = controlledSelectedFillKey !== undefined ? controlledSelectedFillKey : localSelectedFillKey;
  const setPanel = useStableCallback((next: AccountPanelKind | null) => {
    if (onPanelChange) onPanelChange(next);
    else setLocalPanel(next);
  });
  const setSelectedFillKey = useStableCallback((next: string | null) => {
    if (onSelectFillKey) onSelectFillKey(next);
    else setLocalSelectedFillKey(next);
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
  const forensicsQuery = useExecutionForensics(choice.current?.ref ?? null, panel === "fills");
  const forensicItems = forensicsQuery.data?.items ?? [];

  const goTo: GoToSymbol = useStableCallback((target) => {
    const layout = useLayoutStore.getState();
    layout.pinSymbol(windowId, null);
    layout.sendSymbol(windowId, useSelectionStore.getState().activeCell, target);
    setSelectedFillKey(null);
    setPanel(null);
  });

  const inspectFill = useStableCallback((rowKey: string, fill: TradingExecution, forensic: ExecutionForensic | undefined) => {
    setSelectedFillKey(rowKey);
    const layout = useLayoutStore.getState();
    layout.pinSymbol(windowId, null);
    layout.sendSymbol(windowId, useSelectionStore.getState().activeCell, { code: fill.code, name: fill.name });
    if (forensic !== undefined) {
      useChartPointerStore.getState().snapTo(fill.code, forensic.fillAt, fill.price);
    }
  });

  const closePanel = useStableCallback(() => {
    setSelectedFillKey(null);
    setPanel(null);
  });

  const hasOpenForensic = panel === "fills" && selectedFillKey !== null && forensicItems.length > 0;

  return (
    <div className="od-account" data-testid="order-account" data-anchor-ready={anchorReady}>
      <div className="od-account-bar">
        <div className="od-account-head">
          <AccountLabel choice={choice} maskAccount={maskAccount} onPick={onPick} />
          {mock && <Badge tone="accent" className="od-env"><span data-testid="account-mock">모의투자</span></Badge>}
          <span className="od-route" data-testid="account-route" title="주문 경로">{routeLabel(venue)}</span>
          {policy !== null && <Badge tone={policy === "allow_margin" ? "warning" : "success"} className="od-policy"><span data-testid="margin-policy" data-policy={policy}>{POLICY_LABEL[policy]}</span></Badge>}
        </div>
        <div className="od-account-tabs">
          {TABS.map(({ kind, label, shortLabel }) => (
            <button
              key={kind}
              ref={(el) => { tabButtons.current[kind] = el; }}
              type="button"
              className="od-tab"
              data-testid={`account-tab-${kind}`}
              aria-expanded={panel === kind}
              onClick={(e) => {
                opener.current = e.currentTarget;
                if (panel === kind) {
                  setSelectedFillKey(null);
                  setPanel(null);
                } else {
                  setSelectedFillKey(null);
                  setPanel(kind);
                }
              }}
            >
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
          data-forensic-open={hasOpenForensic ? "" : undefined}
        >
          {panel === "open" && <OpenPanel orders={openOrders} writable={writable} onCancel={onCancel} goTo={goTo} />}
          {panel === "holdings" && <HoldingsPanel balance={balance} activeHolding={holding} goTo={goTo} />}
          {panel === "fills" && (
            <FillsPanel
              executions={executions}
              forensics={forensicItems}
              selectedKey={selectedFillKey}
              onSelect={inspectFill}
              goTo={goTo}
            />
          )}
        </Popover>
      )}
    </div>
  );
});
