import { constants } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { scaleInputs } from "./fixtures/scale.ts";
import { jsonSizer } from "./json-size.ts";

const directory = path.resolve(import.meta.dirname, "../../target/leader-cases-173/scale");
await mkdir(directory, { recursive: true });
const { bundle, requests } = await scaleInputs(directory);
const compact = jsonSizer(), pretty = jsonSizer(2);
const fields = Object.fromEntries(Object.entries(bundle).map(([key, value]) => [key, { compact: compact(value), pretty: pretty(value, 1) }]));
const report = { requests, rows: { dailyPrices: bundle.prices.reduce((n, p) => n + (p.kind === "ok" ? p.data.daily.length : 0), 0), quarters: bundle.dart.financials.quarters.length, timeline: bundle.dart.financials.timeline.length, valuation: bundle.valuation.length }, maxStringLength: constants.MAX_STRING_LENGTH, compact: compact(bundle), pretty: pretty(bundle), fields, financials: Object.fromEntries(Object.entries(bundle.dart.financials).map(([key, value]) => [key, { compact: compact(value), pretty: pretty(value, 3) }])), valuation: Object.fromEntries(Object.keys(bundle.valuation[0]!).map((key) => [key, compact(bundle.valuation.map((v) => Object.entries(v).find(([name]) => name === key)?.[1]))])) };
await writeFile(path.join(directory, "sizes.json"), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
