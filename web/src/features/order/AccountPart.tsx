import { memo } from "react";
import type { MarginPolicy } from "../../api/generated/MarginPolicy";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import type { Venue } from "../../api/generated/Venue";
import type { WindowId } from "../../layout/kinds";
import type { ValueStore } from "../../lib/valueStore";
import { AccountBand } from "./AccountBand";
import type { ProfitUnit } from "./holdingSummary";
import { HoldingSummary } from "./HoldingSummary";
import type { HoverCell } from "./OrderLadder";
import { OrderSettingsPopover } from "./OrderSettingsPopover";
import type { OrderAccountChoice } from "./orderAccount";
import type { BuyingPower } from "./orderRules";
import type { OrderSettings, PresetKind } from "./orderSettings";
import { HoverOrderEstimate, QuantityRow } from "./QuantityRow";

interface Props {
  readonly windowId: WindowId;
  readonly choice: OrderAccountChoice;
  readonly accountRef: string | null;
  readonly onPickAccount: (accountRef: string) => void;
  readonly openOrders: readonly TradingOpenOrder[];
  readonly balance: TradingBalance | null;
  readonly executions: readonly TradingExecution[];
  readonly writable: boolean;
  readonly mock: boolean;
  readonly policy: MarginPolicy | null;
  readonly onCancel: (orderNo: string) => void;
  readonly holding: TradingHolding | null;
  readonly orderable: TradingOrderable | null;
  readonly buyableProblem: string | null;
  readonly sellOrdered: number;
  readonly profitUnit: ProfitUnit;
  readonly onProfitUnit: () => void;
  readonly presetKind: PresetKind;
  readonly input: string;
  readonly referencePrice: number | null;
  readonly onPresetKind: (kind: PresetKind) => void;
  readonly onInput: (input: string) => void;
  readonly quantity: number;
  readonly buying: BuyingPower | null;
  readonly hover: ValueStore<HoverCell | null>;
  readonly explorerOn: boolean;
  readonly explorerUnavailable: boolean;
  readonly explorerTitle: string | undefined;
  readonly onToggleExplorer: () => void;
  readonly onCurrent: () => void;
  readonly settings: OrderSettings;
  readonly orderVenue: Venue;
  readonly nxtNotTraded: boolean;
  readonly onSettings: (settings: OrderSettings) => void;
}

export const AccountPart = memo(function AccountPart(props: Props) {
  const { settings } = props;
  return (
    <>
      <AccountBand windowId={props.windowId} choice={props.choice} onPick={props.onPickAccount} maskAccount={settings.maskAccount} openOrders={props.openOrders} balance={props.balance} executions={props.executions} writable={props.writable} mock={props.mock} policy={props.policy} onCancel={props.onCancel} />
      <HoldingSummary account={props.accountRef} holding={props.holding} orderable={props.orderable} buyableProblem={props.buyableProblem} sellOrdered={props.sellOrdered} unit={props.profitUnit} onUnit={props.onProfitUnit} onFill={props.onInput} />
      <div className="od-entry">
        <QuantityRow presetKind={props.presetKind} input={props.input} sharePresets={settings.sharePresets} amountPresets={settings.amountPresets} referencePrice={props.referencePrice} keepLastEntry={settings.keepLastEntry} onPresetKind={props.onPresetKind} onInput={props.onInput} />
        <div className="od-toolbar">
          <HoverOrderEstimate hover={props.hover} quantity={props.quantity} referencePrice={props.referencePrice} buying={props.buying} />
          <button type="button" className="od-tool" data-testid="order-explorer" aria-pressed={props.explorerOn} disabled={props.explorerUnavailable} title={props.explorerTitle} onClick={props.onToggleExplorer}>전체 호가</button>
          <button type="button" className="od-tool" data-testid="order-current" disabled={!props.explorerOn} onClick={props.onCurrent}>현재가</button>
          <OrderSettingsPopover settings={settings} venue={props.orderVenue} mock={props.mock} nxtNotTraded={props.nxtNotTraded} holding={props.holding !== null} onChange={props.onSettings} />
        </div>
      </div>
    </>
  );
});
