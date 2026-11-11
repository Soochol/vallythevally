import type { Bundle, Measure } from "./bundle-types.ts";
import { SECTION_TITLES, type Manuscript, type Sentence } from "./manuscript.ts";
import { reportPanels, summary } from "./report-model.ts";

export function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
export function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}
const h = escapeHtml;
const a = (url: string, title: string) => `<a href="${h(url)}" target="_blank" rel="noopener noreferrer">${h(title)}</a>`;
function sentences(items: readonly Sentence[]): string {
  return items.map((s) => `<p class="sentence"><strong>${s.kind === "then-visible" ? `당시 보였던 것 · ${h(s.asOf)}` : "사후 해석"}</strong> ${h(s.text)} ${s.citations.map((c) => a(c.url, `${c.publishedOn} · ${c.quote}`)).join(" · ")}</p>`).join("");
}
function details(title: string, value: unknown): string { return `<details><summary>${h(title)}</summary><pre>${h(JSON.stringify(value, null, 2))}</pre></details>`; }
export function measureEvidence(title: string, m: Measure): string {
  const paths = "paths" in m && Array.isArray(m.paths) ? details("TTM 후보 paths · activePaths · evaluatedOn", m) : "";
  return `<li>${h(title)}: ${m.value === null ? `자료 없음 · ${h(m.reason)}` : `${h(m.value)} ${h(m.unit)}`} · availableFrom ${h(m.availableFrom)}${m.sources.map((s) => `<div>${a(s.url, `${s.receipt} · ${s.filedOn}`)} · ${h(s.accountId)} · ${h(s.accountName)} · ${h(s.match)} · ${h(s.field)}</div>`).join("")}${paths}</li>`;
}
export function reportPage(bundle: Bundle, manuscript: Manuscript, browserScript: string): string {
  const panels = reportPanels(bundle);
  const sum = summary(bundle, manuscript);
  const shell = (id: string) => `<div class="chart-slot" id="slot-${h(id)}"></div>`;
  const f = bundle.dart.financials;
  const events = manuscript.events.map((e) => `<li>${h(e.publishedOn)} · ${a(e.url, e.title)} · ${h(e.kind)}${sentences(e.sentences)}</li>`).join("");
  const extras: Record<number, string> = {
    0: `<p>상승률 ${h(sum.risePct?.toFixed(2) ?? "자료 없음")}% · 정점부터 소멸일까지 최대 낙폭 ${h(sum.postPeakDrawdownPct?.toFixed(2) ?? "자료 없음")}%</p>${Object.entries(manuscript.milestones).map(([key, m]) => `<article><h3>${({ birth: "탄생일", peak: "정점", extinction: "소멸일" })[key as "birth" | "peak" | "extinction"]} ${h(m.day)}</h3>${sentences(m.evidence)}</article>`).join("")}${shell("overview")}`,
    1: `<ul>${events}</ul>`,
    2: `<p>회계기간 축 · 최신 다운로드 기준 요약. 당시 공개된 값은 6절의 공시일 축에서 확인합니다.</p><label>회계기간 <select id="accounting-mode"><option value="quarterly">분기</option><option value="annual">연간</option></select></label><div id="accounting-charts"></div><div id="accounting-ledger"></div>`,
    3: `<p>수출 통계 · 제품 가격 · 수주 · 고객사/경쟁사 실적 · 컨센서스 · 목표주가 · 리포트 수는 원고의 공개일과 원문 인용으로 확인합니다.</p>`,
    4: `<p>섹터 지도 기준일 ${h(bundle.sectorMap.asOf)} · 현재 지도와 생존 편향을 고려해야 합니다.</p>${details("섹터 구성·기여 종목·순위 분모·확산도·미확인 종목", { map: bundle.sectorMap, series: bundle.sectors })}`,
    5: `<p>장세는 지수별 배경 띠입니다. 기준금리 결정 · 지수 편입/편출 · 이전상장은 사건 연표의 공개일과 원문을 확인합니다.</p>`,
    6: `<p>주봉은 각 주 마지막 실제 관측일에 표시합니다. 날짜 커서는 값이 없는 패널에서도 같은 날짜를 가리킵니다. 공시일 축은 timeline의 당시 사용 가능한 값을 다음 변경점까지 유지합니다.</p><p>탄생일 │ 정점 │ 소멸일 · 장세: 상승(bull), 하락(bear), 횡보(sideways), 자료 없음(띠 없음)</p><div id="panel-controls"></div><div id="time-charts">${panels.filter((p) => p.id !== "overview").map((p) => shell(p.id)).join("")}</div>${details("모든 조정 · 깊이·기간·거래량", bundle.corrections)}${details("상대강도와 가격의 52주 신고가 날짜", bundle.technical.filter((t) => t.high52w || t.stockToMarketHigh52w || t.stockToSectorHigh52w || t.sectorToMarketHigh52w))}<details><summary>공시일 축 재무 근거 · 충돌·누락·미공개 후보</summary><p>paths는 점검용 후보입니다. activePaths만 evaluatedOn에 이용 가능합니다. 미공개 후보는 당시 알려진 수치가 아닙니다.</p>${f.timeline.map((p) => `<details><summary>${h(p.day)} · ${h(p.financialPeriod)}</summary><ul>${p.values ? Object.entries(p.values).map(([key, value]) => measureEvidence(key, value)).join("") : "자료 없음"}</ul></details>`).join("")}</details>`,
    7: `<p>기관 누적 순매수는 보유수량이 아닙니다. 첫 유효 관측일 이전 보유량은 알 수 없습니다. 누락 뒤에는 segmentStart부터 새 구간 누적으로 재개합니다.</p>${details("누적 기준 시작·누락·구간 재개·알려진 부분합", bundle.institutionCumulative)}${details("수급 coverage·누락일·날짜 없는 행", { foreign: bundle.foreignHoldings, netShares: bundle.investorNetShares })}`,
    8: `<p>상승률 분해의 날짜는 자료 묶음에서 계산 가능한 처음·마지막 날짜이며, 원고의 생애 기준일과 다를 수 있습니다.</p>${details("상승률 분해", bundle.returnDecomposition)}`,
    9: `<p>자본 사건은 공시 계획입니다. 실행·전환이나 실제 지분 변화를 뜻하지 않습니다.</p>${details("자본·지분 공시 원장", bundle.dart.capitalEvents)}`,
    12: `<p>생존 편향 · 수정주가 · 기관 누적 시작값 불명 · FRED 최신 수정 빈티지의 발표 지연 미확인.</p><ul>${[...bundle.limitations, ...f.limitations].map((s) => `<li>${h(s)}</li>`).join("")}</ul>${details("자료 실패·누락", { missing: bundle.missing, dartFailures: bundle.dart.sourceFailures, priceFailures: bundle.prices.filter((p) => p.kind === "missing") })}${details("회사식별 근거", bundle.dart.identity)}${details("FRED 빈티지·원 관측일·한국 날짜 정렬", bundle.fred)}${details("현재 스냅숏 · 과거 시총 대용 아님", bundle.currentFundamentals)}${details("재무 원장·최신 회계기간 요약", f)}${details("공시 목록과 출처", bundle.dart.disclosures)}<p>${a("https://www.tradingview.com/", "Charts by TradingView Lightweight Charts")} · Apache-2.0</p>`,
  };
  const sections = manuscript.sections.map((s) => `<section id="section-${s.number}"><h2>${s.number}. ${h(SECTION_TITLES[s.number])}</h2>${sentences(s.sentences)}${extras[s.number] ?? ""}</section>`).join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'"><title>${h(manuscript.title)}</title><style>
body{font-family:system-ui,sans-serif;margin:24px;color:#222;background:white}main{max-width:1320px;margin:auto}section{margin-block:40px}h1,h2,h3{line-height:1.4}p,li{line-height:1.65}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:480px;overflow:auto}details{margin-block:10px;border:1px solid #ddd;padding:8px}summary{cursor:pointer}table{border-collapse:collapse;width:100%;margin-block:12px}th,td{border:1px solid #ddd;padding:6px;text-align:left}.sentence strong{font-size:.85em;border:1px solid #999;padding:2px 4px;margin-right:4px}.chart-frame{position:relative;border:1px solid #ccc;margin:12px 0;padding:8px}.chart{height:220px;position:relative}.chart-overlay{position:absolute;inset:0;pointer-events:none;overflow:hidden}.milestone,.date-cursor,.event-line{position:absolute;top:0;bottom:28px;border-left:1px dashed #777;font-size:10px;white-space:nowrap}.milestone span{background:#fff}.date-cursor{border-left:1px solid #111;z-index:4}.event-line{border-color:#b85;font-size:9px}.regime{position:absolute;top:0;bottom:28px;opacity:.12}.bull{background:#36875a}.bear{background:#ac4444}.sideways{background:#888}.legend{font-size:12px}.no-data{color:#744}.group-toggle{margin:8px 12px 8px 0}.chart-slot:empty{display:none}output{display:block;font-variant-numeric:tabular-nums}nav a{display:inline-block;margin-right:10px}button,select{font:inherit}#accounting-charts .chart{height:180px}
</style></head><body><main><h1>${h(manuscript.title)}</h1><p>${h(bundle.code)} · 생성 ${h(bundle.generatedAt)} · 원고와 자료를 내장한 주도 사례 리포트</p><nav>${SECTION_TITLES.map((title, i) => `<a href="#section-${i}">${i}. ${h(title)}</a>`).join("")}</nav>${sections}</main><script id="report-data" type="application/json">${jsonForHtml({ bundle, manuscript })}</script><script>${browserScript.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}
