import { isFinancial, type IndicatorSpec } from "./kinds";
import init, { validateSpec } from "../../wasm/indicators/indicators.js";
import wasmUrl from "../../wasm/indicators/indicators_bg.wasm?url";
import type { Validate } from "./kinds";

let ready: Promise<Validate> | null = null;

export function loadValidator(): Promise<Validate> {
  ready ??= init({ module_or_path: wasmUrl }).then(() => (spec: IndicatorSpec) => isFinancial(spec) ? { ok: true, errors: [] } : validateSpec(JSON.stringify(spec)));
  return ready;
}
