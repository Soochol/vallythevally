import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import init, { WasmEngine, futureBarStarts, validateSpec } from "../src/wasm/indicators/indicators.js";

const reference = new URL("../../crates/indicators/tests/reference/", import.meta.url);

async function table(name) {
  const text = await readFile(new URL(`${name}.csv`, reference), "utf8");
  const [header, ...rows] = text.trim().split("\n").filter((l) => !l.startsWith("#"));
  const names = header.split(",");
  const cols = Object.fromEntries(names.map((n) => [n, []]));
  for (const row of rows) row.split(",").forEach((cell, i) => cols[names[i]].push(cell === "" ? NaN : Number(cell)));
  return cols;
}

await init({ module_or_path: await readFile(new URL("../src/wasm/indicators/indicators_bg.wasm", import.meta.url)) });

const input = await table("input");
const t = Float64Array.from(input.close, (_, i) => 1_700_000_000 + i * 86_400);
const cols = ["open", "high", "low", "close", "volume"].map((n) => Float64Array.from(input[n]));

const cases = [
  [{ kind: "ma", method: "ema", period: 12 }, "ma_ema_12"],
  [{ kind: "bollinger", period: 20, k: 2 }, "bollinger_20_2"],
  [{ kind: "ichimoku", conversion: 9, base: 26, spanB: 52, displacement: 26 }, "ichimoku_9_26_52_26"],
  [{ kind: "volume", maPeriod: 20 }, "volume_20"],
  [{ kind: "rsi", period: 14, signal: 9 }, "rsi_14_9"],
  [{ kind: "macd", fast: 12, slow: 26, signal: 9 }, "macd_12_26_9"],
  [{ kind: "stochSlow", k: 5, d: 3, smooth: 3 }, "stoch_slow_5_3_3"],
];

for (const [spec, file] of cases) {
  const want = await table(file);
  const engine = new WasmEngine(JSON.stringify(spec), t, ...cols);
  const lines = engine.lines();
  assert.deepEqual(lines.toSorted(), Object.keys(want).toSorted(), file);
  lines.forEach((id, index) => {
    const got = engine.line(index);
    want[id].forEach((w, i) => {
      if (!Number.isNaN(w)) assert.ok(Math.abs(got[i] - w) <= 1e-6, `${file} ${id}[${i}]: ${got[i]} vs ${w}`);
    });
  });
  if (spec.kind === "ichimoku") assert.deepEqual(lines.map((_, i) => engine.shift(i)), [0, 0, 25, 25, -25]);

  const last = cols.map((c) => c.at(-1));
  const head = new WasmEngine(JSON.stringify(spec), t.subarray(0, -1), ...cols.map((c) => c.subarray(0, -1)));
  const preview = head.preview(t.at(-1), ...last);
  assert.deepEqual(head.preview(t.at(-1), ...last), preview, `${file}: preview changed the state`);
  assert.deepEqual(head.pushConfirmed(t.at(-1), ...last), preview, `${file}: pushConfirmed differs from preview`);
  assert.deepEqual(Array.from(preview), lines.map((_, i) => engine.line(i).at(-1)), `${file}: tail differs from compute`);
  engine.free();
  head.free();
}

assert.deepEqual(validateSpec('{"kind":"rsi","period":14,"signal":null}'), { ok: true });
const bad = validateSpec('{"kind":"macd","fast":26,"slow":12,"signal":9}');
assert.equal(bad.ok, false);
assert.deepEqual(bad.errors.map((e) => e.field), ["slow"]);
assert.equal(validateSpec("{").errors[0].field, "");
assert.throws(() => new WasmEngine('{"kind":"ma","method":"sma","period":0}', t, ...cols), /period/);
assert.throws(() => new WasmEngine('{"kind":"ma","method":"sma","period":5}', t.subarray(1), ...cols), /길이/);

const sma2 = new WasmEngine('{"kind":"ma","method":"sma","period":2}', [60], [10], [10], [10], [10], [10]);
for (const t of [60, 59, 120.5, NaN, Infinity]) {
  assert.throws(() => sma2.preview(t, 30, 30, 30, 30, 30), Error, `preview t=${t}`);
  assert.throws(() => sma2.pushConfirmed(t, 30, 30, 30, 30, 30), Error, `pushConfirmed t=${t}`);
}
assert.throws(() => sma2.pushConfirmed(120, 30, 30, 30, NaN, 30), /close/);
assert.throws(() => new WasmEngine('{"kind":"ma","method":"sma","period":2}', [60, 120], [10, 30], [10, 30], [10, 30], [10, NaN], [10, 30]), /close/);
assert.equal(sma2.line(0).length, 1, "rejected bars changed the state");
assert.deepEqual(Array.from(sma2.preview(120, 30, 30, 30, 30, 30)), Array.from(sma2.preview(120, 30, 30, 30, 30, 30)));
assert.deepEqual(Array.from(sma2.pushConfirmed(120, 30, 30, 30, 30, 30)), [20]);
sma2.free();

const kst = (iso) => Date.parse(`${iso}+09:00`) / 1000;
assert.deepEqual(Array.from(futureBarStarts("1m", kst("2026-11-06T19:59:00"), 2)), [kst("2026-11-09T08:00:00"), kst("2026-11-09T08:01:00")]);
assert.deepEqual(Array.from(futureBarStarts("M", kst("2026-10-01T00:00:00"), 1)), [kst("2026-11-01T00:00:00")]);
assert.throws(() => futureBarStarts("1m", kst("2026-11-06T19:59:30"), 1), /봉 시작 시각/);
assert.throws(() => futureBarStarts("2m", kst("2026-11-06T19:59:00"), 1));

console.log(`wasm smoke: ${cases.length} specs match the reference CSVs`);
