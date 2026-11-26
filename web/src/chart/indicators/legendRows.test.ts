import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TrackedValues } from "../legendShapes";
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
  get lastElementChild(): FakeElement | null { return this.children[this.children.length - 1] ?? null; }
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

test("배치 줄보다 그리는 줄의 가격 줄이 적으면 알약은 그리는 줄의 가격 줄을 센다", () => {
  const legend = newLegend();
  legend.setLayoutRows([...MOVING_AVERAGES, VOLUME_ON_PRICE], []);
  expect(foldLabel(legend)).toBe("지표 8");
  legend.render([...MOVING_AVERAGES, VOLUME_PANE], []);
  expect(foldLabel(legend)).toBe("지표 7");
});

test("배치 줄보다 그리는 줄의 가격 줄이 많으면 알약은 그리는 줄의 가격 줄을 센다", () => {
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

test("setLayoutRows는 같은 모양 갱신에는 false, 모양·상태·줄 바뀜에는 true를 돌려준다", () => {
  const legend = newLegend();
  const row = movingAverage(5);
  const slot = new TrackedValues();
  slot.setAll(["71,200", "72,300"]);
  expect(legend.setLayoutRows([row], [{ id: row.id, slots: [slot.values] }])).toBe(true);
  slot.setAt(1, "79,800");
  expect(legend.setLayoutRows([row], [{ id: row.id, slots: [slot.values] }])).toBe(false);
  slot.setAt(1, "100,000");
  expect(legend.setLayoutRows([row], [{ id: row.id, slots: [slot.values] }])).toBe(true);
  slot.setAt(1, "75,000");
  expect(legend.setLayoutRows([row], [{ id: row.id, slots: [slot.values] }])).toBe(true);
  expect(legend.setLayoutRows([{ ...row, state: "hidden" }], [{ id: row.id, slots: [] }])).toBe(true);
  expect(legend.setLayoutRows([{ ...row, state: "hidden" }], [{ id: row.id, slots: [] }])).toBe(false);
});

test("지표 범례 줄은 이름과 단추에만 title을 두고 줄 컨테이너에는 중복 title을 두지 않는다", () => {
  const overlay = new FakeElement("div");
  const legend = new IndicatorLegend(overlay as unknown as HTMLElement, () => {});
  const ma = movingAverage(20);
  legend.render([ma, VOLUME_PANE], []);
  const rowsBox = legend.priceBox.children[1] as unknown as FakeElement;
  const priceRow = rowsBox.children[0]!;
  const panelRow = overlay.children[0]!;
  const nameOf = (row: FakeElement) => row.children.find((child) => "indicatorEdit" in child.dataset);
  expect(priceRow.title).toBe("");
  expect(nameOf(priceRow)?.title).toBe(ma.name);
  expect(panelRow.title).toBe("");
  expect(nameOf(panelRow)?.title).toBe(VOLUME_PANE.name);
});
