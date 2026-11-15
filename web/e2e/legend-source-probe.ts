import type { Page } from "@playwright/test";
import { expect } from "./harness";

type Counts = { base: number; indicator: number; compare: number; fit: number; paint: number };
type Field = { key: string; alternatives: string[]; measuredAlternatives: string[]; width: number };
type Projection = { density: string; fields: Field[]; nodes: number; peakNodes: number; safe: boolean };

declare global {
  interface Window {
    legendSources: { counts: Counts; projections: Projection[]; holdWorkers: boolean; pendingWorkers: (() => void)[]; times: number[]; rawAlternatives: WeakMap<HTMLElement, string[]> };
  }
}

export async function installLegendSourceProbe(page: Page, holdWorkers = false): Promise<void> {
  await page.addInitScript((hold) => {
    const probe: Window["legendSources"] = window.legendSources = { counts: { base: 0, indicator: 0, compare: 0, fit: 0, paint: 0 }, projections: [], holdWorkers: hold, pendingWorkers: [], times: [], rawAlternatives: new WeakMap() };
    const alternatives = new WeakMap<HTMLElement, Pick<Field, "alternatives" | "measuredAlternatives">>();
    const attachmentSafety = new WeakMap<HTMLElement, boolean>();
    const peakNodes = new WeakMap<HTMLElement, number>();
    const append = Element.prototype.append;
    Element.prototype.append = function (...nodes) {
      for (const node of nodes) if (node instanceof HTMLElement && node.matches(".chart-legend[aria-hidden=true]")) attachmentSafety.set(node, node.inert && node.style.visibility === "hidden" && node.style.pointerEvents === "none");
      append.apply(this, nodes);
      if (!(this instanceof HTMLElement)) return;
      for (const node of nodes) if (node instanceof HTMLElement && node.style.whiteSpace === "pre" && node.style.height === "0px") {
        const raw = probe.rawAlternatives.get(this);
        if (!raw) throw new Error("측정 전 범례 원천 필드가 없습니다");
        alternatives.set(this, { alternatives: raw, measuredAlternatives: (node.textContent ?? "").split("\n") });
        const root = this.closest<HTMLElement>(".chart-legend[aria-hidden=true]");
        if (root) peakNodes.set(root, Math.max(peakNodes.get(root) ?? 0, root.querySelectorAll("*").length));
      }
    };
    const remove = Element.prototype.remove;
    Element.prototype.remove = function () {
      if (this instanceof HTMLElement && this.matches(".chart-legend[aria-hidden=true]")) {
        const key = (element: HTMLElement) => {
          const price = element.closest("[data-price-row]");
          if (price) return `price/${[...price.children].indexOf(element)}`;
          const ohlc = element.closest("[data-ohlc]");
          if (ohlc) return `ohlc/${[...ohlc.children].findIndex((child) => child === element.parentElement)}`;
          const row = element.closest<HTMLElement>("[data-indicator-row],[data-compare-row]");
          if (row?.dataset.indicatorRow) return `indicator/${row.dataset.indicatorRow}/${[...(element.parentElement?.children ?? [])].indexOf(element)}`;
          return `compare/${row?.dataset.compareRow}`;
        };
        const fields = [...this.querySelectorAll<HTMLElement>("*")].flatMap((element) => {
          const values = alternatives.get(element);
          return values ? [{ key: key(element), ...values, width: element.getBoundingClientRect().width }] : [];
        });
        probe.projections.push({ density: this.closest<HTMLElement>("[data-chart-overlay-host]")?.dataset.legendDensity ?? "normal", fields, nodes: this.querySelectorAll("*").length, peakNodes: peakNodes.get(this) ?? 0, safe: attachmentSafety.get(this) === true });
      }
      remove.call(this);
    };
    const post = Worker.prototype.postMessage;
    const workers = new WeakSet<Worker>();
    Worker.prototype.postMessage = function (message, transfer) {
      if (!workers.has(this)) {
        workers.add(this);
        this.addEventListener("message", (event: MessageEvent<unknown>) => {
          const data = event.data;
          if (!data || typeof data !== "object" || !("results" in data) || !Array.isArray(data.results)) return;
          for (const result of data.results) if (result && typeof result === "object" && "draws" in result && Array.isArray(result.draws)) {
            for (const draw of result.draws) if (draw && typeof draw === "object" && "points" in draw && Array.isArray(draw.points)) {
              for (const point of draw.points) if (point && typeof point === "object" && "t" in point && typeof point.t === "number") probe.times.push(point.t);
            }
          }
        });
      }
      const send = () => post.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
      if (probe.holdWorkers && message && typeof message === "object" && "type" in message && message.type === "create") probe.pendingWorkers.push(send);
      else send();
    };
  }, holdWorkers);
  await page.route("**/assets/*.js", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    if (!body.includes("priceLegendValues()")) return route.fulfill({ response, body });
    const measurement = /function \w+\((\w+)\)\{(?=(?:let|const) \w+=\1\.map\(\(\{element:\w+\}\)=>getComputedStyle\(\w+\)\))/g;
    expect([...body.matchAll(measurement)]).toHaveLength(1);
    body = body.replace(measurement, (match, fields: string) => `${match}for(const field of ${fields})window.legendSources.rawAlternatives.set(field.element,Array.from(field.alternatives));`);
    const entries = [
      { expression: /setLayoutBars\(\w+\)\{/g, name: "base" },
      { expression: /priceLegendValues\(\)\{/g, name: "indicator" },
      { expression: /legendValues\(\w+\)\{/g, name: "compare" },
      { expression: /refreshPresentation\(\)\{/g, name: "fit" },
      { expression: /paintLegend\(\)\{/g, name: "paint" },
    ];
    for (const { expression, name } of entries) {
      expect([...body.matchAll(expression)]).toHaveLength(1);
      body = body.replace(expression, (match) => `${match}window.legendSources.counts.${name}++;`);
    }
    await route.fulfill({ response, body });
  });
}
