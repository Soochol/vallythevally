import { WINDOW_KINDS, type WindowId } from "../../layout/kinds";
import { MarketWindowGate, PreparingBody } from "../market-window/MarketWindowGate";

export function BrokersWindow({ id }: { id: WindowId }) {
  return <MarketWindowGate id={id}>{(code) => <PreparingBody code={code} kindName={WINDOW_KINDS.brokers.name} />}</MarketWindowGate>;
}
