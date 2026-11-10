import type { IndicatorSpec } from "../../api/generated/IndicatorSpec";
import init, { validateSpec } from "../../wasm/indicators/indicators.js";
import wasmUrl from "../../wasm/indicators/indicators_bg.wasm?url";
import type { Validate } from "./kinds";

let ready: Promise<Validate> | null = null;

export function loadValidator(): Promise<Validate> {
  ready ??= init({ module_or_path: wasmUrl }).then(() => (spec: IndicatorSpec) => validateSpec(JSON.stringify(spec)));
  return ready;
}
