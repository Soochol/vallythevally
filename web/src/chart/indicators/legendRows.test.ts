import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { IndicatorRow } from "./layer";
import { IndicatorLegend } from "./legendRows";

class FakeElement {
  className = "";
  textContent = "";
  innerHTML = "";
  title = "";
  type = "";
  hidden = false;
  open = false;
  onclick: unknown = null;
  readonly dataset: Record<string, string> = {};
  readonly style = { removeProperty: () => {}, setProperty: () => {} } as unknown as Record<string, string>;
  readonly classList = { toggle: () => {} };
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get lastElementChild(): FakeElement | null { return this.children.at(-1) ?? null; }
  get isConnected(): boolean { return false; }
  append(...nodes: FakeElement[]) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes: FakeElement[]) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  toggleAttribute(name: string, force: boolean) { if (force) this.attributes.set(name, ""); else this.attributes.delete(name); return force; }
  addEventListener() {}
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  closest() { return null; }
  focus() {}
}

beforeEach(() => {
  vi.stubGlobal("document", { createElement: (tag: string) => new FakeElement(tag), activeElement: null });
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("getComputedStyle", () => ({ marginTop: "0px" }));
});

afterEach(() => { vi.unstubAllGlobals(); });

const movingAverage = (period: number): IndicatorRow => ({ id: `ma${period}`, name: `이동평균 ${period}`, color: "#000", values: [], state: "ok", panel: null });
const volume = (panel: IndicatorRow["panel"]): IndicatorRow => ({ id: "volume", name: "거래량", color: "#000", values: [], state: "ok", panel });
const MOVING_AVERAGES = [5, 10, 20, 60, 120, 200, 240].map(movingAverage);
const VOLUME_PANE = volume({ index: 0, count: 1 });
const VOLUME_ON_PRICE = volume(null);

function foldLabel(legend: IndicatorLegend): string {
  return (legend.priceBox.firstElementChild?.firstElementChild?.textContent ?? "");
}

function newLegend(): IndicatorLegend {
  return new IndicatorLegend(document.createElement("div"), () => {});
}

test("배치 줄을 거래량이 가격 줄이던 상태로 만든 뒤 요청 없이 거래량 패널 상태로 그리면 알약은 그린 가격 줄 수를 센다", () => {
  const legend = newLegend();
  legend.setLayoutRows([...MOVING_AVERAGES, VOLUME_ON_PRICE], []);
  expect(foldLabel(legend)).toBe("지표 8");
  legend.render([...MOVING_AVERAGES, VOLUME_PANE], []);
  expect(foldLabel(legend)).toBe("지표 7");
});

test("배치 줄을 만든 뒤 설정이 바뀌어 십자선 그리기가 먼저 오면 그 그리기에서 알약이 새 가격 줄 수를 따른다", () => {
  const legend = newLegend();
  legend.setLayoutRows([...MOVING_AVERAGES.slice(0, 4), VOLUME_PANE], []);
  expect(foldLabel(legend)).toBe("지표 4");
  legend.render([...MOVING_AVERAGES.slice(0, 5), VOLUME_PANE], []);
  expect(foldLabel(legend)).toBe("지표 5");
});

test("배치 줄과 그리는 줄의 가격 줄 수가 같으면 그리기가 알약을 다시 맞추지 않는다", () => {
  const legend = newLegend();
  legend.setLayoutRows([...MOVING_AVERAGES, VOLUME_PANE], []);
  const label = legend.priceBox.firstElementChild?.firstElementChild;
  legend.render([...MOVING_AVERAGES, VOLUME_PANE], []);
  expect(legend.priceBox.firstElementChild?.firstElementChild).toBe(label);
  expect(foldLabel(legend)).toBe("지표 7");
});
