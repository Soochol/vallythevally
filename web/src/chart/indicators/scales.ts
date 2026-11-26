import type { IndicatorConfig, IndicatorAxis, Panel } from "../settings";
import { isFinancial, isFinancialBar, type IndicatorSpec } from "./kinds";

export type ScaleDomain =
  | "bound_0_100"
  | "volume"
  | "oscillator_zero"
  | "flow_won"
  | "percent"
  | "financial_won"
  | "financial_per_share";

export type ResolvedAxisSlot = "right" | "left" | "overlay";

export interface ResolvedScale {
  readonly slot: ResolvedAxisSlot;
  readonly domain: ScaleDomain;
  readonly explicit: boolean;
}

export function scaleDomainOf(spec: IndicatorSpec): ScaleDomain {
  switch (spec.kind) {
    case "rsi":
    case "stochSlow":
      return "bound_0_100";
    case "volume":
    case "quoteTotals":
      return "volume";
    case "macd":
      return "oscillator_zero";
    case "tickCvd":
    case "programFlow":
      return "flow_won";
    case "dps":
      return "financial_per_share";
    default:
      if (isFinancial(spec)) return isFinancialBar(spec.kind) ? "financial_won" : "percent";
      return "oscillator_zero";
  }
}

export function resolvePanelScales(configs: readonly IndicatorConfig[], panelId: Panel["id"]): Map<string, ResolvedScale> {
  const members = configs.filter((config) => config.panel === panelId);
  const resolved = new Map<string, ResolvedScale>();
  let rightDomain: ScaleDomain | null = null;
  let leftDomain: ScaleDomain | null = null;

  for (const config of members) {
    const domain = scaleDomainOf(config.spec);
    if (config.axis === "right") {
      resolved.set(config.id, { slot: "right", domain, explicit: true });
      if (rightDomain === null) rightDomain = domain;
    } else if (config.axis === "left") {
      resolved.set(config.id, { slot: "left", domain, explicit: true });
      if (leftDomain === null) leftDomain = domain;
    } else if (config.axis === "overlay") {
      resolved.set(config.id, { slot: "overlay", domain, explicit: true });
    }
  }

  for (const config of members) {
    if (resolved.has(config.id)) continue;
    const domain = scaleDomainOf(config.spec);
    if (rightDomain === null || rightDomain === domain) {
      resolved.set(config.id, { slot: "right", domain, explicit: false });
      rightDomain = domain;
    } else if (leftDomain === null || leftDomain === domain) {
      resolved.set(config.id, { slot: "left", domain, explicit: false });
      leftDomain = domain;
    } else {
      resolved.set(config.id, { slot: "overlay", domain, explicit: false });
    }
  }

  return resolved;
}

export function nextIndicatorAxis(current: ResolvedAxisSlot): Exclude<IndicatorAxis, "auto"> {
  if (current === "right") return "left";
  if (current === "left") return "overlay";
  return "right";
}

export function axisSlotLabel(slot: ResolvedAxisSlot): string {
  if (slot === "right") return "R";
  if (slot === "left") return "L";
  return "독립";
}

export function priceScaleIdFor(config: IndicatorConfig, slot: ResolvedAxisSlot): string {
  if (slot === "right") return "right";
  if (slot === "left") return "left";
  return `overlay:${config.id}`;
}
