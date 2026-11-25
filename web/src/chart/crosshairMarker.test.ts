import { afterEach, describe, expect, test, vi } from "vitest";
import type { IChartApi } from "lightweight-charts";
import type { Bar } from "../api/generated/Bar";
import { barInterval } from "./crosshairSync";
import { CrosshairMarker } from "./crosshairMarker";

const NINE = Date.UTC(2026, 10, 23, 0, 0, 0) / 1000;
const BARS: Bar[] = [
  { t: NINE, o: 70_000, h: 70_200, l: 69_900, c: 70_100, v: 1_000 },
  { t: NINE + 60, o: 70_100, h: 70_300, l: 70_000, c: 70_200, v: 1_100 },
];

interface FakeNode {
  dataset: Record<string, string>;
  style: Record<string, string>;
  hidden: boolean;
  textContent: string;
  children: FakeNode[];
  offsetWidthReads: number;
  setAttribute(name: string, value: string): void;
  append(...nodes: FakeNode[]): void;
  remove(): void;
  readonly offsetWidth: number;
}

function makeNode(): FakeNode {
  const node: FakeNode = {
    dataset: {},
    style: {},
    hidden: false,
    textContent: "",
    children: [],
    offsetWidthReads: 0,
    setAttribute() {},
    append(...nodes) { this.children.push(...nodes); },
    remove() {},
    get offsetWidth() {
      this.offsetWidthReads++;
      return 64;
    },
  };
  return node;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CrosshairMarker", () => {
  test("skips host visibility reads when hidden and caches label width across repeated refreshes on the same bar", () => {
    const created: FakeNode[] = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const node = makeNode();
        created.push(node);
        return node;
      },
    });

    let layoutReads = 0;
    const hostEl = {
      isConnected: true,
      get clientWidth() { layoutReads++; return 800; },
      get clientHeight() { layoutReads++; return 500; },
      checkVisibility: () => { layoutReads++; return true; },
      append() {},
    } as unknown as HTMLElement;

    const chart = {
      timeScale: () => ({
        timeToCoordinate: () => 240,
        width: () => 720,
        height: () => 28,
      }),
    } as unknown as IChartApi;

    const marker = new CrosshairMarker({
      element: hostEl,
      chart,
      bars: () => BARS,
      period: () => "1m",
    });
    const [root, line, label] = created as [FakeNode, FakeNode, FakeNode];

    marker.refresh();
    marker.refresh();
    expect(layoutReads).toBe(0);
    expect(root.hidden).toBe(true);

    marker.show(barInterval(NINE, "1m"));
    expect(root.hidden).toBe(false);
    expect(line.style.left).toBe("240px");
    expect(label.offsetWidthReads).toBe(1);

    marker.refresh();
    marker.refresh();
    expect(label.offsetWidthReads).toBe(1);

    marker.show(barInterval(NINE + 60, "1m"));
    expect(label.offsetWidthReads).toBe(2);

    marker.show(null);
    expect(root.hidden).toBe(true);
    const readsBeforeIdle = layoutReads;
    marker.refresh();
    expect(layoutReads).toBe(readsBeforeIdle);

    marker.dispose();
  });
});
