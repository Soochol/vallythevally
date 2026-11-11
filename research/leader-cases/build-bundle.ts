import type { Bundle, Day, PriceSeries, SourceResult } from "./bundle-types.ts";
import { readSectorMap } from "./sector-map.ts";
import { capture, httpClient, kstDay, type HttpClient } from "./source-utils.ts";
import { readForeign, readFundamentals, readInvestors, readPrices, readSymbol } from "./server-source.ts";
import { buildSectors, corrections, marketRegimes, technicalWeeks } from "./price-calculations.ts";
import { readDart } from "./dart-source.ts";
import { valuations } from "./financial-calculations.ts";
import { FRED_SERIES, readFred } from "./fred-source.ts";
import { accumulateInstitutions } from "./investor-calculations.ts";

export interface BundleOptions {
  server: URL;
  code: string;
  corp: string;
  from: Day;
  to: Day;
  mapPath: string;
  dartBase: URL;
  fredBase: URL;
  dartKey: string | null;
}
export async function buildBundle(options: BundleOptions, client: HttpClient = httpClient): Promise<Bundle> {
  const { server, code, from, to } = options;
  const generatedAt = new Date().toISOString();
  const map = await readSectorMap(options.mapPath);
  const codes = [...new Set([code, ...map.sectors.flatMap((s) => s.stocks.map((st) => st.code)), "IDX:001", "IDX:101"])];
  const prices: Array<SourceResult<PriceSeries>> = [];
  for (const symbol of codes) prices.push(await capture(`server/bars/${symbol}`, () => readPrices({ base: server, symbol, to, client })));
  const successful = prices.flatMap((p) => p.kind === "ok" ? [p.data] : []);
  const kospi = successful.find((p) => p.symbol === "IDX:001");
  const kosdaq = successful.find((p) => p.symbol === "IDX:101");
  const calendar = [...new Set([...(kospi?.daily ?? []), ...(kosdaq?.daily ?? [])].map((b) => b.day))].sort();
  const target = successful.find((p) => p.symbol === code);
  const symbol = await capture(`server/symbols/${code}`, () => readSymbol(server, code, client));
  const currentFundamentals = await capture(`server/fundamentals/${code}`, async () => ({ fetchedAt: new Date().toISOString(), values: await readFundamentals(server, code, client), historical: false as const }));
  const historyArgs = { base: server, code, from, to, client };
  const foreignHoldings = await capture(`server/foreign-holdings/${code}`, () => readForeign(historyArgs));
  const investorNetShares = await capture(`server/investor-net-shares/${code}`, () => readInvestors(historyArgs));
  const sectors = buildSectors(map, successful, calendar);
  const sector = sectors.find((s) => map.sectors.find((m) => m.id === s.id)?.stocks.some((stock) => stock.code === code));
  const market = symbol.kind === "ok" ? symbol.data.market === "kosdaq" ? kosdaq : kospi : undefined;
  const dart = await readDart({ base: options.dartBase, code, corp: options.corp, key: options.dartKey, fromYear: 2015, toYear: Number(to.slice(0, 4)), filingTo: kstDay(Date.parse(generatedAt) / 1000), calendar, client });
  const fred = [];
  for (const definition of FRED_SERIES) fred.push(await capture(`FRED/${definition.id}`, () => readFred({ base: options.fredBase, definition, to, calendar, client })));
  const valuation = valuations(target?.daily ?? [], dart.financials, currentFundamentals.kind === "ok" ? currentFundamentals.data.values.listedShares : null);
  const first = valuation.find((v) => v.day >= from && v.per.value !== null);
  const last = valuation.findLast((v) => v.per.value !== null);
  const firstPrice = target?.daily.find((b) => b.day === first?.day)?.c;
  const lastPrice = target?.daily.find((b) => b.day === last?.day)?.c;
  const factorReason = { value: null, reason: "need_positive_earnings_and_reconciled_share_basis_at_both_dates" } satisfies Bundle["returnDecomposition"]["earningsFactor"];
  const allResults = [...prices, symbol, currentFundamentals, foreignHoldings, investorNetShares, dart.disclosures, ...dart.capitalEvents, ...fred];
  const missing = [...dart.sourceFailures, ...allResults.flatMap((r) => r.kind === "missing" ? [{ source: r.source, reason: r.reason }] : [])];
  if (!sector) missing.push({ source: `sector-map/${code}`, reason: "target_not_in_sector_map" });
  for (const r of [foreignHoldings, investorNetShares]) if (r.kind === "ok") {
    if (r.data.coverage.kind !== "whole_range") missing.push({ source: r.source, reason: r.data.coverage.kind });
    if (r.data.skippedDays.length) missing.push({ source: r.source, reason: `skipped_days_${r.data.skippedDays.length}` });
    if (r.data.undatedRows.length) missing.push({ source: r.source, reason: `undated_rows_${r.data.undatedRows.length}` });
  }
  const rangeCalendar = calendar.filter((d) => d >= from && d <= to);
  return {
    schemaVersion: 2, generatedAt, code, range: { from, to }, calendar: rangeCalendar, sectorMap: map, symbol, currentFundamentals, prices, sectors,
    technical: target ? technicalWeeks(target, market, sector).filter((w) => w.day >= from) : [],
    markets: [kospi, kosdaq].flatMap((p) => p ? [{ symbol: p.symbol, days: marketRegimes(p.daily).filter((d) => d.day >= from) }] : []),
    foreignHoldings, investorNetShares, institutionCumulative: accumulateInstitutions(investorNetShares, rangeCalendar), dart, fred, valuation: valuation.filter((v) => v.day >= from),
    returnDecomposition: { from: first?.day ?? null, to: last?.day ?? null, priceFactor: firstPrice && lastPrice ? lastPrice / firstPrice : null, earningsFactor: first?.epsTtm.value != null && last?.epsTtm.value != null ? { value: last.epsTtm.value / first.epsTtm.value, reason: null } : factorReason, perFactor: first?.per.value != null && last?.per.value != null ? { value: last.per.value / first.per.value, reason: null } : factorReason },
    corrections: corrections(target?.daily ?? []).filter((c) => c.recoveredOn === null || c.recoveredOn >= from), missing,
    limitations: [
      "Prices are KRX adjusted daily bars downloaded now, not historical price vintages; live/current bars are excluded.",
      "Bars API exposes OHLCV only. Actual traded value, its 10-week average and market share are null; close times volume is not actual traded value.",
      "Historical marketwide shares and prices are unavailable, so historical market capitalization rank is null. Current fundamentals are a separately timestamped snapshot.",
      "Sector membership is the current map and excludes delisted stocks, creating survivorship bias. First observed date in the exhausted price history is used as the listing proxy.",
      "Sector index = chained daily equal-weight price returns, rebalanced daily; IPO starts contributing returns on its second observation. Missing established-member observations break the index chain.",
      "Sector/member rank uses 13 observation-week intervals, competition ranks with ties. Rank denominators show calculable sectors/members only.",
      "52-week close highs require 52 consecutive observed calendar weeks, include the current week and ties; incomplete breadth is null with denominator and unknown count.",
      "Institution net shares are changes since the first readable observation, not holdings. Missing days start new segments and partial known sums never represent unknown past holdings.",
      "FRED CSV is a latest revised download, not a historical publication vintage. Daily values are used only on strictly later Korean dates; monthly averages only after month end, with unknown release lag.",
      "Capital-event detail fields are announcements in original units, not proof of execution. Conversion exercise, block trades, major shareholder sales and policy/index changes require linked manual disclosure review.",
      "Original filing vintages and split-adjusted historical per-share denominators are not reconstructed. Valuation is null where a later issued-common-share snapshot prevents reconciling the price/share basis; treasury-only outstanding-share changes do not erase prior values.",
      ...(calendar.length === 0 ? ["Both index calendars unavailable; no observation dates or aligned financial values inferred."] : []),
    ],
  };
}
