import type { IndicatorSpec } from "../../api/generated/IndicatorSpec";
import init, { type SpecValidation, validateSpec } from "../../wasm/indicators/indicators.js";
import wasmUrl from "../../wasm/indicators/indicators_bg.wasm?url";

export type Validate = (spec: IndicatorSpec) => SpecValidation;

let ready: Promise<Validate> | null = null;

/** 대화상자가 입력마다 부르는 검사(frontend.md §3.3 D6). 엔진이 필요 없어 워커를 거치지 않고, 메인 스레드에서 한 번 init한다. */
export function loadValidator(): Promise<Validate> {
  ready ??= init({ module_or_path: wasmUrl }).then(() => (spec: IndicatorSpec) => validateSpec(JSON.stringify(spec)));
  return ready;
}
