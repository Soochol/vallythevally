import type { Bundle, Measure } from "./bundle-types.ts";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = ""): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag); item.textContent = text; return item;
}
function branch(title: string, render: (host: HTMLElement) => void): HTMLDetailsElement {
  const node = element("details"); node.append(element("summary", title));
  node.addEventListener("toggle", () => {
    if (node.open && !node.dataset.loaded) { render(node); node.dataset.loaded = "true"; }
  });
  return node;
}
function tree(host: HTMLElement, value: unknown) {
  if (value === null || typeof value !== "object") { host.append(element("pre", String(value))); return; }
  if (Array.isArray(value)) {
    if (!value.length) { host.append(element("pre", "[]")); return; }
    if (value.length > 128) {
      for (let start = 0; start < value.length; start += 128) {
        const end = Math.min(value.length, start + 128);
        host.append(branch(`[${start}…${end - 1}]`, (node) => tree(node, value.slice(start, end))));
      }
    } else value.forEach((item, index) => host.append(branch(`[${index}]`, (node) => tree(node, item))));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "object" && item !== null) host.append(branch(key, (node) => tree(node, item)));
    else if (key === "url" && typeof item === "string" && /^https?:\/\//.test(item)) {
      const link = element("a", item); link.href = item; link.target = "_blank"; link.rel = "noopener noreferrer"; host.append(link);
    } else host.append(element("pre", `${key}: ${String(item)}`));
  }
}
function measureEvidence(title: string, value: Measure): HTMLLIElement {
  const item = element("li", `${title}: ${value.value === null ? `자료 없음 · ${value.reason}` : `${value.value} ${value.unit}`} · availableFrom ${value.availableFrom}`);
  for (const source of value.sources) {
    const row = element("div");
    const link = element("a", `${source.receipt} · ${source.filedOn}`); link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    row.append(link, document.createTextNode(` · ${source.accountId} · ${source.accountName} · ${source.match} · ${source.field}`)); item.append(row);
  }
  if ("paths" in value) item.append(branch("TTM 후보 paths · activePaths · evaluatedOn", (node) => tree(node, value)));
  return item;
}
export function mountEvidence(bundle: Bundle) {
  const f = bundle.dart.financials;
  const values: Record<string, () => unknown> = {
    sectors: () => ({ map: bundle.sectorMap, series: bundle.sectors }),
    corrections: () => bundle.corrections,
    highs: () => bundle.technical.filter((t) => t.high52w || t.stockToMarketHigh52w || t.stockToSectorHigh52w || t.sectorToMarketHigh52w),
    institutions: () => bundle.institutionCumulative,
    flows: () => ({ foreign: bundle.foreignHoldings, netShares: bundle.investorNetShares }),
    decomposition: () => bundle.returnDecomposition,
    capital: () => bundle.dart.capitalEvents,
    missing: () => ({ missing: bundle.missing, dartFailures: bundle.dart.sourceFailures, priceFailures: bundle.prices.filter((p) => p.kind === "missing") }),
    identity: () => bundle.dart.identity,
    fred: () => bundle.fred,
    fundamentals: () => bundle.currentFundamentals,
    financials: () => f,
    disclosures: () => bundle.dart.disclosures,
  };
  for (const host of document.querySelectorAll<HTMLDetailsElement>("details[data-evidence]")) {
    host.addEventListener("toggle", () => {
      if (!host.open || host.dataset.loaded) return;
      if (host.dataset.evidence === "publication") {
        host.append(element("p", "paths는 점검용 후보입니다. activePaths만 evaluatedOn에 이용 가능합니다. 미공개 후보는 당시 알려진 수치가 아닙니다."));
        for (const point of f.timeline) host.append(branch(`${point.day} · ${point.financialPeriod}`, (node) => {
          const entries = element("ul");
          if (point.values) for (const [key, value] of Object.entries(point.values)) entries.append(measureEvidence(key, value));
          else entries.append(element("li", "자료 없음"));
          node.append(entries);
        }));
      } else tree(host, values[host.dataset.evidence!]!());
      host.dataset.loaded = "true";
    });
  }
}
