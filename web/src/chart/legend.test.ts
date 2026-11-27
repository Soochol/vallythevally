import { afterEach, expect, test, vi } from "vitest";
import type { Bar } from "../api/generated/Bar";
import { Legend, type LegendBar, legendParts } from "./legend";

const bar = (over: Partial<Bar>): Bar => ({ t: 1_735_689_600, o: 71_200, h: 72_000, l: 70_000, c: 70_600, v: 1_234_567, ...over });
const parts = (prev: Bar | null) => legendParts({ bar: bar({}), prev, isCurrent: false, isIndex: false, period: "D", stalledAt: null } satisfies LegendBar);

afterEach(() => { vi.unstubAllGlobals(); });

test("시·고·저·종마다 직전 봉 종가 대비 등락률과 방향을 붙이고 거래량에는 붙이지 않는다", () => {
  expect(parts(bar({ c: 70_600 })).cells).toEqual([
    ["시", "71,200", { text: "+0.85%", dir: "up" }],
    ["고", "72,000", { text: "+1.98%", dir: "up" }],
    ["저", "70,000", { text: "−0.85%", dir: "down" }],
    ["종", "70,600", { text: "0.00%", dir: "flat" }],
    ["량", "123만", null],
  ]);
});

test("직전 봉이 없거나 직전 봉 종가가 0이면 등락률을 붙이지 않는다", () => {
  for (const prev of [null, bar({ c: 0 })]) {
    expect(parts(prev).cells.map(([, , change]) => change)).toEqual([null, null, null, null, null]);
  }
});

class FakeText {
  parentElement: FakeEl | null = null;
  constructor(public data: string) {}
  get textContent(): string { return this.data; }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.nodes.splice(this.parentElement.nodes.indexOf(this), 1);
    this.parentElement = null;
  }
}

class FakeEl {
  className = "";
  title = "";
  hidden = false;
  readonly dataset: Record<string, string> = {};
  readonly nodes: (FakeEl | FakeText)[] = [];
  parentElement: FakeEl | null = null;
  private text = "";

  constructor(readonly tagName: string) {}

  get children(): FakeEl[] { return this.nodes.filter((n): n is FakeEl => n instanceof FakeEl); }
  get textContent(): string {
    return this.nodes.length > 0 ? this.nodes.map((n) => n.textContent).join("") : this.text;
  }
  set textContent(value: string) {
    this.nodes.length = 0;
    this.text = value;
  }
  append(...items: (FakeEl | FakeText | string)[]) {
    for (const item of items) {
      const node = typeof item === "string" ? new FakeText(item) : item;
      node.remove();
      node.parentElement = this;
      this.nodes.push(node);
    }
  }
  replaceChildren(...items: (FakeEl | FakeText | string)[]) {
    for (const node of [...this.nodes]) node.remove();
    this.append(...items);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.nodes.splice(this.parentElement.nodes.indexOf(this), 1);
    this.parentElement = null;
  }
  setAttribute() {}
  toggleAttribute() { return true; }
  closest() { return null; }
}

test("범례 OHLC 갱신은 셀 DOM을 다시 만들지 않고 텍스트와 등락률만 제자리에서 바꾼다", () => {
  vi.stubGlobal("document", {
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (text: string) => new FakeText(text),
    fonts: { addEventListener: () => {}, removeEventListener: () => {}, ready: new Promise(() => {}) },
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});

  const parent = new FakeEl("div");
  const legend = new Legend(parent as unknown as HTMLElement, {
    projectRows: () => [],
    readViewport: () => ({ pricePane: null, axisWidth: 72 }),
    applyTier: () => {},
    reserveTop: () => {},
  });
  legend.setDisplay({ showLegend: true, showOhlcChange: true });

  const prev = bar({ c: 70_000 });
  legend.show({ bar: bar({ o: 71_000, h: 72_000, l: 69_000, c: 70_700, v: 500_000 }), prev, isCurrent: false, isIndex: false, period: "D", stalledAt: null }, true);
  const ohlc = legend.body.children[1]!.children[0]!.children[0] as unknown as FakeEl;
  const firstCells = [...ohlc.children];
  expect(firstCells).toHaveLength(5);
  expect(firstCells[0]!.textContent).toBe("시71,000 (+1.43%)");

  legend.show({ bar: bar({ o: 68_600, h: 70_000, l: 68_000, c: 69_300, v: 900_000 }), prev, isCurrent: false, isIndex: false, period: "D", stalledAt: null }, true);
  expect(ohlc.children).toEqual(firstCells);
  expect(firstCells[0]!.textContent).toBe("시68,600 (−2.00%)");
  expect(firstCells[4]!.textContent).toBe("량90만");

  legend.show({ bar: bar({ o: 68_600, h: 70_000, l: 68_000, c: 69_300, v: 900_000 }), prev: null, isCurrent: false, isIndex: false, period: "D", stalledAt: null }, true);
  expect(ohlc.children).toEqual(firstCells);
  expect(firstCells[0]!.textContent).toBe("시68,600");
  legend.dispose();
});

test("범례 머리줄의 정규장 배지는 setHead의 regularHoursOnly에 따라 보이고 숨는다", () => {
  const raf = vi.fn(() => 1);
  vi.stubGlobal("document", {
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (text: string) => new FakeText(text),
    fonts: { addEventListener: () => {}, removeEventListener: () => {}, ready: new Promise(() => {}) },
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", () => {});

  const parent = new FakeEl("div");
  const legend = new Legend(parent as unknown as HTMLElement, {
    projectRows: () => [],
    readViewport: () => ({ pricePane: null, axisWidth: 72 }),
    applyTier: () => {},
    reserveTop: () => {},
  });
  const head = (legend.root as unknown as FakeEl).children[0]!;
  const badge = head.children.find((child) => "regularHoursBadge" in child.dataset);
  expect(badge).toBeDefined();
  expect(badge!.textContent).toBe("정규장");
  expect(badge!.title).toBe("정규장(09:00~15:30) 봉만 표시 중");
  expect(badge!.hidden).toBe(true);

  legend.setHead({ name: "삼성전자", sub: "005930", period: "3분", regularHoursOnly: true });
  expect(badge!.hidden).toBe(false);
  expect(raf).toHaveBeenCalledTimes(1);

  legend.setHead({ name: "삼성전자", sub: "005930", period: "3분", regularHoursOnly: true });
  expect(raf).toHaveBeenCalledTimes(1);

  legend.setHead({ name: "삼성전자", sub: "005930", period: "3분", regularHoursOnly: false });
  expect(badge!.hidden).toBe(true);
  legend.dispose();
});
