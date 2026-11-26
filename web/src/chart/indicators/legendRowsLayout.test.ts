import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { IndicatorRow } from "./layer";
import { IndicatorLegend } from "./legendRows";

type Operation = "read" | "write";
let operations: Operation[] = [];
const record = (operation: Operation) => { operations.push(operation); };

class FakeElement {
  title = "";
  type = "";
  hidden = false;
  open = false;
  onclick: unknown = null;
  readonly dataset: Record<string, string> = {};
  readonly style = new Proxy({ removeProperty: () => {}, setProperty: () => record("write") } as unknown as Record<string, string>, {
    set: (target, key: string, value: string) => { record("write"); target[key] = value; return true; },
  });
  readonly classList = { toggle: () => {} };
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  private text = "";
  private markup = "";
  private names = "";
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

  get textContent(): string { return this.text; }
  set textContent(value: string) { if (value !== this.text) record("write"); this.text = value; }
  get innerHTML(): string { return this.markup; }
  set innerHTML(value: string) { if (value !== this.markup) record("write"); this.markup = value; }
  get className(): string { return this.names; }
  set className(value: string) { if (value !== this.names) record("write"); this.names = value; }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get lastElementChild(): FakeElement | null { return this.children[this.children.length - 1] ?? null; }
  get isConnected(): boolean { return false; }
  append(...nodes: FakeElement[]) { record("write"); for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes: FakeElement[]) { record("write"); for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    record("write");
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
  setAttribute(name: string, value: string) { if (this.attributes.get(name) !== value) record("write"); this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  toggleAttribute(name: string, force: boolean) { if (force) this.attributes.set(name, ""); else this.attributes.delete(name); return force; }
  addEventListener() {}
  querySelectorAll() { return []; }
  getBoundingClientRect() { record("read"); return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 20 }; }
  closest() { return null; }
  focus() {}
}

beforeEach(() => {
  operations = [];
  vi.stubGlobal("document", { createElement: (tag: string) => new FakeElement(tag), activeElement: null });
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("getComputedStyle", () => { record("read"); return { marginTop: "0px" }; });
});

afterEach(() => { vi.unstubAllGlobals(); });

const PANES = [{ top: 0, height: 300 }, { top: 300, height: 100 }, { top: 400, height: 100 }, { top: 500, height: 100 }];
const RESIZED_PANES = [{ top: 0, height: 240 }, { top: 240, height: 120 }, { top: 360, height: 120 }, { top: 480, height: 120 }];
const panelRow = (index: number, value: string): IndicatorRow => ({ id: `panel${index}`, name: `지표 ${index}`, color: "#000", values: [{ text: value, color: "#000" }], state: "ok", panel: { index, count: 3 } });

test("패널 지표 줄은 패널 크기가 바뀔 때 쓰기를 마친 뒤 위치를 한꺼번에 읽는다", () => {
  const legend = new IndicatorLegend(new FakeElement("div") as unknown as HTMLElement, () => {});
  const rows = (value: string) => [0, 1, 2].map((index) => panelRow(index, value));
  legend.render(rows("1"), PANES);
  operations = [];
  legend.render(rows("2"), RESIZED_PANES);
  const first = operations.indexOf("read");
  const last = operations.lastIndexOf("read");
  expect(first).toBeGreaterThanOrEqual(0);
  expect(operations.slice(first, last + 1)).not.toContain("write");
});

test("값만 바뀌는 패널 지표 갱신은 레이아웃을 다시 읽지 않고 값 요소를 제자리에서 고친다", () => {
  const overlay = new FakeElement("div");
  const legend = new IndicatorLegend(overlay as unknown as HTMLElement, () => {});
  const rows = (value: string) => [0, 1, 2].map((index) => panelRow(index, value));
  legend.render(rows("1"), PANES);
  const firstValueNodes = overlay.children.map((row) => row.children.find((child) => "indicatorValues" in child.dataset)!.children[0]);
  operations = [];
  legend.render(rows("2"), PANES);
  expect(operations).not.toContain("read");
  expect(overlay.children.map((row) => row.children.find((child) => "indicatorValues" in child.dataset)!.children[0])).toEqual(firstValueNodes);
  expect(firstValueNodes.map((node) => node?.textContent)).toEqual(["2", "2", "2"]);
  operations = [];
  legend.render(rows("3"), null);
  expect(operations).not.toContain("read");
  expect(firstValueNodes.map((node) => node?.textContent)).toEqual(["3", "3", "3"]);
});

test("합쳐진 패널의 지표 줄은 서로 겹치지 않게 세로로 쌓고 좌측 축 폭만큼 오른쪽으로 밀어 둔다", () => {
  const overlay = new FakeElement("div");
  const legend = new IndicatorLegend(overlay as unknown as HTMLElement, () => {});
  const mergedRows: IndicatorRow[] = [
    { id: "vol", name: "거래량", color: "#000", values: [{ text: "100", color: "#000" }], state: "ok", draggable: true, panel: { index: 0, count: 1, panelId: "p1", slotIndex: 0, memberCount: 2, axisSlot: "right", axisExplicit: false } },
    { id: "rsi", name: "RSI 14", color: "#000", values: [{ text: "55", color: "#000" }], state: "ok", draggable: true, panel: { index: 0, count: 1, panelId: "p1", slotIndex: 1, memberCount: 2, axisSlot: "left", axisExplicit: false } },
  ];
  legend.render(mergedRows, [{ top: 0, height: 300 }, { top: 300, height: 140 }], 72, 60);
  const [first, second] = overlay.children;
  expect(first?.style.top).toBe("304px");
  expect(second?.style.top).toBe("326px");
  expect(first?.style.left).toBe("68px");
  expect(second?.style.left).toBe("68px");
});
