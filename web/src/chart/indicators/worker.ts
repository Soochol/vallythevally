import init, * as wasm from "../../wasm/indicators/indicators.js";
import wasmUrl from "../../wasm/indicators/indicators_bg.wasm?url";
import { Engines } from "./engines";
import type { FromWorker, ToWorker } from "./protocol";
import { wasmAdapter } from "./wasm";

const post = (m: FromWorker) => (self as unknown as { postMessage(m: FromWorker): void }).postMessage(m);

const ready = init({ module_or_path: wasmUrl }).then(
  () => new Engines(wasmAdapter(wasm)),
  (e: unknown) => {
    post({ type: "fatal", message: `지표 계산을 시작하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` });
    return null;
  },
);

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  void ready.then((engines) => {
    if (!engines) return;
    const out = engines.handle(msg);
    if (out) post(out);
  });
};
