import { isTechnical, isTickCvd, type IndicatorSpec, type Validate } from "./kinds";
import init, { validateSpec, type SpecValidation } from "../../wasm/indicators/indicators.js";
import wasmUrl from "../../wasm/indicators/indicators_bg.wasm?url";

let ready: Promise<Validate> | null = null;

export function validateNonTechnicalSpec(spec: IndicatorSpec): SpecValidation {
  if (isTickCvd(spec) && !spec.showWhale && !spec.showLarge && !spec.showMid && !spec.showRetail) {
    return { ok: false, errors: [{ field: "", message: "최소 1개 계층을 선택해야 합니다." }] };
  }
  return { ok: true };
}

export function loadValidator(): Promise<Validate> {
  ready ??= init({ module_or_path: wasmUrl }).then(
    () => (spec: IndicatorSpec) => (isTechnical(spec) ? validateSpec(JSON.stringify(spec)) : validateNonTechnicalSpec(spec)),
  );
  return ready;
}
