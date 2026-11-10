import type { Period } from "../../api/generated/Period";
import type { SpecValidation, WasmEngine } from "../../wasm/indicators/indicators";
import type { Columns } from "./protocol";
import type { Wasm } from "./engines";

export interface WasmModule {
  WasmEngine: typeof WasmEngine;
  validateSpec(specJson: string): SpecValidation;
  futureBarStarts(period: string, lastStart: number, n: number): Float64Array;
}

export function wasmAdapter(m: WasmModule): Wasm {
  return {
    specErrors: (json) => {
      const r = m.validateSpec(json);
      return r.ok ? null : r.errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message));
    },
    newEngine: (json: string, c: Columns) => new m.WasmEngine(json, c.t, c.o, c.h, c.l, c.c, c.v),
    futureBarStarts: (period: Period, lastStart: number, n: number) => m.futureBarStarts(period, lastStart, n),
  };
}
