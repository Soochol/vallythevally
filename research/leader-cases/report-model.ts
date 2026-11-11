import type { Bundle, Day, FinancialMetrics, FinancialPeriod, Measure, WeeklyBar } from "./bundle-types.ts";
import { INSTITUTIONS } from "./bundle-types.ts";
import type { Manuscript } from "./manuscript.ts";

export interface Sample { day: Day; value: number | null; reason: string | null; evidence: Measure | null }
export interface Plot { title: string; unit: string; style: "line" | "step" | "bars" | "dots"; samples: Sample[]; sampling: "daily" | "weekly" | "disclosure"; emptyReason: string | null }
export interface Panel { id: string; title: string; group: string; defaultOpen: boolean; plots: Plot[]; candles: WeeklyBar[] }
export interface FinancialField {
  id: string;
  title: string;
  unit: string;
  style: "step" | "bars";
  accounting: (p: FinancialPeriod, m: FinancialMetrics | null) => Measure | null;
  disclosure: (p: FinancialPeriod | null, m: FinancialMetrics | null) => Measure | null;
}
const metric = (key: keyof FinancialMetrics) => (_p: FinancialPeriod | null, m: FinancialMetrics | null) => m?.[key] ?? null;
export const FINANCIAL_FIELDS: FinancialField[] = [
  { id: "revenue", title: "매출 / 공시일 축 TTM", unit: "KRW", style: "bars", accounting: (p) => p.single.revenue, disclosure: metric("revenueTtm") },
  { id: "operating-profit", title: "영업이익 / 공시일 축 TTM", unit: "KRW", style: "bars", accounting: (p) => p.single.operatingProfit, disclosure: metric("operatingProfitTtm") },
  ...([
    ["operatingMarginPct", "영업이익률", "%"], ["operatingProfitYoyPct", "영업이익 증가율", "%"], ["operatingProfitAccelerationPp", "영업이익 증가율 변화", "%p"],
    ["parentRoePct", "지배주주 ROE", "%"], ["debtRatioPct", "부채비율", "%"],
    ["inventoryWarningPp", "재고 증가율 − 매출 증가율", "%p"], ["receivablesWarningPp", "매출채권 증가율 − 매출 증가율", "%p"], ["bps", "BPS", "KRW/share"],
  ] satisfies Array<[keyof FinancialMetrics, string, string]>).map(([key, title, unit]) => ({ id: key, title, unit, style: "step" as const, accounting: metric(key), disclosure: metric(key) })),
  { id: "eps", title: "EPS / 공시일 축 TTM", unit: "KRW/share", style: "step", accounting: metric("periodEps"), disclosure: metric("epsTtm") },
  ...([
    ["parentNetIncome", "parentNetIncomeTtm", "지배주주순이익"], ["operatingCashFlow", "operatingCashFlowTtm", "영업CF"],
    ["investingCashFlow", "investingCashFlowTtm", "투자CF"], ["capex", "capexTtm", "설비투자"],
  ] satisfies Array<[keyof FinancialPeriod["single"], keyof FinancialMetrics, string]>).map(([key, ttm, title]) => ({ id: key, title: `${title} / 공시일 축 TTM`, unit: "KRW", style: "bars" as const, accounting: (p: FinancialPeriod) => p.single[key], disclosure: metric(ttm) })),
  { id: "fcf", title: "FCF / 공시일 축 TTM", unit: "KRW", style: "bars", accounting: metric("freeCashFlow"), disclosure: metric("freeCashFlowTtm") },
  { id: "shares", title: "보통주 발행수 스냅숏", unit: "shares", style: "step", accounting: (p) => p.commonShares, disclosure: (p) => p?.commonShares ?? null },
  { id: "outstanding-shares", title: "보통주 유통수 스냅숏", unit: "shares", style: "step", accounting: (p) => p.outstandingCommonShares, disclosure: (p) => p?.outstandingCommonShares ?? null },
  { id: "dps", title: "DPS (연간)", unit: "KRW/share", style: "step", accounting: (p) => p.dps, disclosure: (p) => p?.dps ?? null },
];
export function sample(day: Day, value: number | null, reason: string | null = null, evidence: Measure | null = null): Sample {
  return { day, value, reason: value === null ? reason ?? "자료 없음" : null, evidence };
}
export function publishedSample(day: Day, m: Measure | null): Sample {
  if (!m) return sample(day, null, "no_financial_period");
  if (m.value === null) return sample(day, null, m.reason, m);
  if (!m.availableFrom || m.availableFrom > day || m.sources.some((s) => s.filedOn >= day)) return sample(day, null, "not_yet_available", m);
  return sample(day, m.value, m.reason, m);
}
function plot(title: string, unit: string, samples: Sample[], style: Plot["style"] = "line", sampling: Plot["sampling"] = "daily", emptyReason: string | null = null): Plot { return { title, unit, samples, style, sampling, emptyReason }; }
export function accountingPlots(bundle: Bundle, mode: "quarterly" | "annual"): { plots: Plot[]; periods: FinancialPeriod[] } {
  const f = bundle.dart.financials;
  const periods = mode === "annual" ? f.annual : f.quarters;
  const plots = FINANCIAL_FIELDS.map((field) => plot(field.title.split(" / ")[0]!, field.unit, periods.map((p) => {
    const m = mode === "annual" ? f.latestAnnualMetrics.find((v) => v.year === p.year)?.values : f.latestMetrics.find((v) => v.year === p.year && v.quarter === p.quarter)?.values;
    const value = field.accounting(p, m ?? null);
    return sample(p.periodEnd, value?.value ?? null, value?.reason ?? "missing_metric", value);
  }), field.style));
  return { plots, periods };
}
export function reportPanels(bundle: Bundle): Panel[] {
  const panels: Panel[] = [];
  const add = (id: string, title: string, group: string, defaultOpen: boolean, plots: Plot[], candles: WeeklyBar[] = []) => panels.push({ id, title, group, defaultOpen, plots, candles });
  const prices = bundle.prices.flatMap((p) => p.kind === "ok" ? [p.data] : []);
  const target = prices.find((p) => p.symbol === bundle.code);
  const tech = bundle.technical;
  const technicalPlot = (title: string, key: "sma10" | "sma30" | "sma40" | "stockToMarket" | "stockToSector" | "sectorToMarket" | "disparity40Pct" | "drawdownPct" | "rangePct" | "rsi14" | "macd" | "macdSignal" | "macdHistogram", unit = "%", style: Plot["style"] = "line") => plot(title, unit, tech.map((t) => sample(t.day, t[key], "insufficient_history_or_missing_input")), style, "weekly");
  const nullPlot = (title: string, key: "turnoverWon" | "turnoverSma10Won" | "marketSharePct" | "marketCapRank", unit: string, style: Plot["style"] = "line") => plot(title, unit, tech.map((t) => sample(t.day, t[key].value, t[key].reason)), style, "weekly");
  add("overview", "상장 이후 전체 흐름", "요약", true, [plot("수정 종가", "KRW", target?.daily.map((p) => sample(p.day, p.c)) ?? [])]);
  const pricePlots = [technicalPlot("SMA 10주", "sma10", "KRW"), technicalPlot("SMA 30주", "sma30", "KRW"), technicalPlot("SMA 40주", "sma40", "KRW")];
  pricePlots.push(plot("52주 신고가", "KRW", tech.map((t) => sample(t.day, t.high52w ? target?.weekly.find((b) => b.observedOn === t.day)?.c ?? null : null, t.high52w === null ? "insufficient_history" : "not_a_52_week_high")), "dots", "weekly"));
  for (const multiple of [10, 20, 40, 80]) pricePlots.push(plot(`PER ${multiple}배`, "KRW", bundle.valuation.map((v) => publishedSample(v.day, v.perBands.find((b) => b.multiple === multiple)?.price ?? null)), "step"));
  add("price", "주봉 가격 · SMA 10/30/40주 · 52주 신고가 · PER 밴드", "기본", true, pricePlots, target?.weekly ?? []);
  add("turnover", "거래대금과 10주 평균", "기본", true, [nullPlot("거래대금", "turnoverWon", "KRW", "bars"), nullPlot("10주 평균", "turnoverSma10Won", "KRW")]);
  const rs = [technicalPlot("종목 ÷ 지수", "stockToMarket", "ratio"), technicalPlot("종목 ÷ 섹터", "stockToSector", "ratio"), technicalPlot("섹터 ÷ 지수", "sectorToMarket", "ratio")];
  for (const [key, high, title] of [["stockToMarket", "stockToMarketHigh52w", "종목 ÷ 지수"], ["stockToSector", "stockToSectorHigh52w", "종목 ÷ 섹터"], ["sectorToMarket", "sectorToMarketHigh52w", "섹터 ÷ 지수"]] as const) rs.push(plot(`${title} 52주 신고가`, "ratio", tech.map((t) => sample(t.day, t[high] ? t[key] : null, t[high] === null ? "insufficient_history" : "not_a_52_week_high")), "dots", "weekly"));
  add("relative-strength", "상대강도 3선과 52주 신고가", "기본", true, rs);
  const sector = bundle.sectors.find((s) => bundle.sectorMap.sectors.find((m) => m.id === s.id)?.stocks.some((st) => st.code === bundle.code));
  add("sector-rank", "섹터 순위 · 섹터 안 순위", "기본", true, [plot("섹터 순위", "rank", sector?.weekly.map((s) => sample(s.day, s.rank)) ?? [], "step", "weekly"), plot("섹터 안 순위", "rank", sector?.weekly.map((s) => sample(s.day, s.memberRanks.find((m) => m.code === bundle.code)?.rank ?? null)) ?? [], "step", "weekly")]);
  const holdings = bundle.foreignHoldings;
  const holdingsReason = holdings.kind === "missing" ? holdings.reason : holdings.data.coverage.kind;
  add("foreign-shares", "외국인 보유수량", "기본", true, [plot("외국인 보유수량", "shares", holdings.kind === "ok" ? holdings.data.days.map((h) => sample(h.day as Day, h.shares)) : [], "line", "daily", holdingsReason)]);
  add("foreign-weight", "외국인 보유비율", "기본", true, [plot("외국인 보유비율", "%", holdings.kind === "ok" ? holdings.data.days.map((h) => sample(h.day as Day, h.weightPct)) : [], "line", "daily", holdingsReason)]);
  const institutionNames = { institution: "기관계", financialInvestment: "금융투자", insurance: "보험", investmentTrust: "투신", otherFinancial: "기타금융", bank: "은행", pensionFund: "연기금", privateFund: "사모", government: "국가" };
  add("institution", "기관 누적 순매수 수량 · 관측 구간별", "기본", true, INSTITUTIONS.map((key) => plot(institutionNames[key], "shares", bundle.institutionCumulative.map((c) => sample(c.day, c.segmentNet?.[key] ?? null, c.reason)))));
  const financials = bundle.dart.financials;
  for (const field of FINANCIAL_FIELDS) {
    const samples = financials.timeline.map((point) => {
      const p = financials.quarters.find((p) => `${p.year}-Q${p.quarter}` === point.financialPeriod);
      const annual = field.id === "dps" ? financials.annual.findLast((a) => a.dps.availableFrom !== null && a.dps.availableFrom <= point.day) : null;
      return publishedSample(point.day, field.disclosure(annual ?? p ?? null, point.values));
    });
    add(`financial-${field.id}`, `${field.title} · 공시일 축`, field.id === "operatingProfitYoyPct" ? "기본" : "재무", field.id === "operatingProfitYoyPct", [plot(field.title, field.unit, samples, "step", "disclosure")]);
  }
  add("market-share", "시장 거래대금 비중", "거래·규모", false, [nullPlot("시장 비중", "marketSharePct", "%")]);
  add("market-cap-rank", "시가총액 순위", "거래·규모", false, [nullPlot("시가총액 순위", "marketCapRank", "rank", "step")]);
  add("disparity", "40주 이격도", "기술", false, [technicalPlot("종가 ÷ 40주선 − 1", "disparity40Pct")]);
  add("drawdown", "고점 대비 낙폭", "기술", false, [technicalPlot("고점 대비 낙폭", "drawdownPct")]);
  add("range", "주간 변동폭", "기술", false, [technicalPlot("주간 변동폭", "rangePct")]);
  add("rsi", "RSI 14주", "기술", false, [technicalPlot("RSI 14주", "rsi14")]);
  add("macd", "MACD", "기술", false, [technicalPlot("MACD", "macd", "KRW"), technicalPlot("신호선", "macdSignal", "KRW"), technicalPlot("차이", "macdHistogram", "KRW", "bars")]);
  add("sector-index", "섹터 지수 · 확산도", "섹터", false, [plot("섹터 지수", "index", sector?.daily.map((s) => sample(s.day, s.value, s.reason)) ?? []), plot("52주 신고가 비율", "%", sector?.weekly.map((s) => sample(s.day, s.breadthPct)) ?? [], "line", "weekly")]);
  for (const m of bundle.markets) add(`market-${m.symbol.replace(":", "-")}`, m.symbol === "IDX:001" ? "코스피 · 장세" : "코스닥 · 장세", "시장환경", false, [plot(m.symbol, "index", m.days.map((d) => sample(d.day, d.close)))]);
  for (const fred of bundle.fred) add(`fred-${fred.kind === "ok" ? fred.data.id : fred.source.replace(/\W/g, "-")}`, fred.kind === "ok" ? `${fred.data.id} · ${fred.data.frequency}` : fred.source, "시장환경", false, [plot(fred.source, fred.kind === "ok" ? fred.data.unit : "", fred.kind === "ok" ? fred.data.aligned.map((d) => sample(d.day, d.value, d.reason)) : [], "step", "daily", fred.kind === "missing" ? fred.reason : null)]);
  add("valuation", "PER · PBR", "밸류에이션", false, [plot("PER", "multiple", bundle.valuation.map((v) => publishedSample(v.day, v.per))), plot("PBR", "multiple", bundle.valuation.map((v) => publishedSample(v.day, v.pbr)))]);
  add("pbr-bands", "PBR 가격 밴드", "밸류에이션", false, [1, 2, 4, 8].map((multiple) => plot(`PBR ${multiple}배`, "KRW", bundle.valuation.map((v) => publishedSample(v.day, v.pbrBands.find((b) => b.multiple === multiple)?.price ?? null)), "step")));
  return panels;
}
export function calendarFor(panels: Panel[], bundle: Bundle, manuscript: Manuscript): Day[] {
  return [...new Set([
    ...bundle.calendar, ...panels.flatMap((p) => [...p.plots.flatMap((s) => s.samples.map((v) => v.day)), ...p.candles.map((c) => c.observedOn)]),
    ...Object.values(manuscript.milestones).map((m) => m.day), ...manuscript.events.map((e) => e.publishedOn),
    ...(bundle.dart.disclosures.kind === "ok" ? bundle.dart.disclosures.data.map((d) => d.filedOn) : []),
  ])].sort();
}
export function summary(bundle: Bundle, manuscript: Manuscript) {
  const target = bundle.prices.find((p) => p.kind === "ok" && p.data.symbol === bundle.code);
  const daily = target?.kind === "ok" ? target.data.daily : [];
  const at = (d: Day) => daily.find((b) => b.day === d)?.c;
  const birth = at(manuscript.milestones.birth.day), peak = at(manuscript.milestones.peak.day);
  const postPeak = daily.filter((b) => b.day >= manuscript.milestones.peak.day && b.day <= manuscript.milestones.extinction.day).map((b) => b.c);
  return { risePct: birth && peak ? (peak / birth - 1) * 100 : null, postPeakDrawdownPct: peak && postPeak.length ? (Math.min(...postPeak) / peak - 1) * 100 : null };
}
