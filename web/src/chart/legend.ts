import type { Bar } from "../api/generated/Bar";
import type { Period } from "../api/generated/Period";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import { type Direction, direction, formatChange, formatPercent, formatPrice, formatVolume } from "../lib/format";
import type { PaneBounds } from "./indicators/legendRows";
import { reserveLegendFields, type LegendField, type LegendProjection } from "./legendProjection";
import type { ChartSettings } from "./settings";
import { formatBarTime, formatKstClock } from "./time";

const ROW_SURFACE = "pr-1 rounded-s bg-[color-mix(in_srgb,var(--chart-bg)_78%,transparent)]";
const ROW = `w-max ${ROW_SURFACE}`;
const OHLC_LINE = `relative z-[6] flex items-center ${ROW_SURFACE} max-md:w-auto`;
const OHLC = "flex flex-wrap gap-x-2 whitespace-nowrap text-s max-md:gap-x-1.5";
const VENUE_AND_OHLC = "flex min-w-0 items-baseline gap-x-2 gap-y-1 [&>:empty]:hidden";
const OHLC_ALONE = { line: `w-max ${OHLC_LINE}`, group: VENUE_AND_OHLC, values: OHLC };
const OHLC_ALONE_WITH_CHANGE = { ...OHLC_ALONE, line: `w-fit max-w-full ${OHLC_LINE}` };
const OHLC_WITH_VENUE_AND_NOTICE = {
  line: `w-fit max-w-full flex-wrap gap-x-2 gap-y-1 ${OHLC_LINE}`,
  group: `flex-wrap ${VENUE_AND_OHLC}`,
  values: `grow basis-0 ${OHLC}`,
};
const DIR_CLASS = { up: "text-up", down: "text-down", flat: "text-text-2" } as const;

export interface LegendBar {
  bar: Bar;
  prev: Bar | null;
  /** 진행 중 구간(BarsPage.current)의 봉이면 `조회 값`을 붙인다. */
  isCurrent: boolean;
  isIndex: boolean;
  period: Period;
  /** 실시간이 멈췄으면 그 시각. 가격줄 끝에 `멈춤 HH:MM`을 붙이고 종가를 흐리게 한다(frontend.md §2.2 W4-32). */
  stalledAt: UnixSeconds | null;
}

export interface PrevCloseChange {
  text: string;
  dir: Direction;
}

export interface LegendParts {
  close: string;
  change: string;
  dir: Direction;
  time: string;
  cells: [label: string, value: string, change: PrevCloseChange | null][];
}

export type LegendDisplay = Pick<ChartSettings, "showLegend" | "showOhlcChange">;

function prevCloseChange(value: number, prev: Bar | null): PrevCloseChange | null {
  if (!prev || prev.c === 0) return null;
  const chg = value - prev.c;
  return { text: formatPercent((chg / prev.c) * 100), dir: direction(chg) };
}

export function legendParts({ bar, prev, isIndex, period }: LegendBar): LegendParts {
  const chg = prev ? bar.c - prev.c : 0;
  return {
    close: formatPrice(bar.c, isIndex),
    change: prev ? `${formatChange(chg, isIndex)}  ${formatPercent((chg / prev.c) * 100)}` : "",
    dir: direction(chg),
    time: formatBarTime(bar.t, period),
    cells: [
      ["시", formatPrice(bar.o, isIndex), prevCloseChange(bar.o, prev)],
      ["고", formatPrice(bar.h, isIndex), prevCloseChange(bar.h, prev)],
      ["저", formatPrice(bar.l, isIndex), prevCloseChange(bar.l, prev)],
      ["종", formatPrice(bar.c, isIndex), prevCloseChange(bar.c, prev)],
      ["량", formatVolume(bar.v), null],
    ],
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

function priceFields() {
  const row = el("div", `${ROW} flex items-baseline gap-2 whitespace-nowrap max-md:hidden`);
  row.dataset.priceRow = "";
  const fields = {
    close: el("span", "text-xl font-semibold tracking-[-0.02em]"),
    change: el("span", "text-s whitespace-pre"),
    time: el("span", "text-xs text-text-2"),
    fetched: el("span", "self-center rounded-[9px] border border-line px-1.5 text-xs text-text-3", "조회 값"),
    stalled: el("span", "self-center rounded-[9px] border border-accent px-1.5 text-xs text-accent"),
  };
  row.append(fields.close, fields.change, fields.time, fields.fetched, fields.stalled);
  return { row, fields };
}

function ohlcClasses({ showLegend, showOhlcChange }: LegendDisplay) {
  return !showLegend ? OHLC_WITH_VENUE_AND_NOTICE : showOhlcChange ? OHLC_ALONE_WITH_CHANGE : OHLC_ALONE;
}

function ohlcCell([label, value, change]: LegendParts["cells"][number], withChange: boolean) {
  const root = el("span", "");
  const name = el("i", "mr-[3px] not-italic text-text-3", label);
  root.append(name, value);
  if (change && withChange) root.append(" ", el("span", DIR_CLASS[change.dir], `(${change.text})`));
  return { root, name };
}

function statusParts(value: LegendBar) {
  return { fetched: value.isCurrent ? "조회 값" : "", stalled: value.stalledAt === null ? "" : `멈춤 ${formatKstClock(value.stalledAt)}` };
}

type PriceAlternatives = { [K in keyof ReturnType<typeof priceFields>["fields"]]: string[] };
type LayoutAlternatives = { price: PriceAlternatives; cells: { label: string; values: string[] }[]; present: boolean };

function emptyAlternatives(): LayoutAlternatives {
  return { price: { close: [], change: [], time: [], fetched: [], stalled: [] }, cells: [], present: false };
}

type LegendViewport = { readonly pricePane: PaneBounds | null; readonly axisWidth: number };
type LegendHost = {
  readonly projectRows: () => readonly LegendProjection[];
  readonly readViewport: () => LegendViewport;
};
type GeometryBox = Pick<DOMRectReadOnly, "x" | "y" | "width" | "height">;
type LegendGeometryInputs = {
  readonly desktop: boolean;
  readonly chart: GeometryBox;
  readonly host: GeometryBox;
  readonly viewport: LegendViewport;
  readonly toolbar: { readonly element: HTMLElement; readonly normal: string; readonly moved: boolean; readonly visible: boolean } | null;
};
type PresentationState = { readonly kind: "invalidated" } | { readonly kind: "settled"; readonly inputs: LegendGeometryInputs };
type LayoutChange = "content" | "geometry";

function geometryBox(element: HTMLElement): GeometryBox {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}

function sameBox(first: GeometryBox, second: GeometryBox): boolean {
  return first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height;
}

function sameGeometryInputs(first: LegendGeometryInputs, second: LegendGeometryInputs): boolean {
  return first.desktop === second.desktop && sameBox(first.chart, second.chart) && sameBox(first.host, second.host)
    && first.viewport.axisWidth === second.viewport.axisWidth
    && first.viewport.pricePane?.top === second.viewport.pricePane?.top && first.viewport.pricePane?.height === second.viewport.pricePane?.height
    && first.toolbar?.element === second.toolbar?.element && first.toolbar?.normal === second.toolbar?.normal
    && first.toolbar?.moved === second.toolbar?.moved && first.toolbar?.visible === second.toolbar?.visible;
}

/**
 * 칸 왼쪽 위 범례(frontend.md §2.3). React가 아니라 컨트롤러가 DOM을 직접 고친다.
 * 휴대폰에서는 머리줄과 가격줄을 휴대폰 머리가 대신하므로 숨긴다(§4).
 */
export class Legend {
  readonly root = el("div", "chart-legend pointer-events-none absolute left-5 top-[calc(1rem+var(--legend-shift,0px))] flex max-w-[calc(100%-90px)] flex-col gap-2");
  readonly body = el("div", "relative z-[4] flex min-w-0 flex-col gap-2");
  private readonly name = el("span", "pointer-events-none min-w-0 truncate text-l font-[650]");
  private readonly sub = el("span", "flex-none text-s text-text-3");
  readonly venueAnchor = el("span", "inline-flex flex-none max-md:hidden");
  private readonly period = el("span", "flex-none text-s text-text-3");
  private readonly price = priceFields();
  private readonly notice = el("span", "break-keep text-xs text-accent max-md:hidden");
  private readonly head = el("div", "relative z-[6] flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-s bg-[color-mix(in_srgb,var(--chart-bg)_78%,transparent)] pr-1 max-md:hidden");
  private readonly ohlcLine = el("div", OHLC_ALONE.line);
  private readonly venueAndOhlc = el("div", OHLC_ALONE.group);
  private readonly ohlc = el("div", OHLC_ALONE.values);
  private display: LegendDisplay = { showLegend: true, showOhlcChange: false };
  private ohlcContent = "";
  private layout = emptyAlternatives();

  private readonly host: HTMLElement;
  private readonly presentationResize: ResizeObserver;
  private readonly presentationMutations: MutationObserver;
  private readonly toolbarMutations: MutationObserver;
  private presentation: PresentationState = { kind: "invalidated" };
  private presentationFrame: number | null = null;
  private disposed = false;
  private readonly fontsChanged = () => this.fit("content");

  constructor(private readonly parent: HTMLElement, private readonly presentationHost: LegendHost) {
    this.host = parent.closest<HTMLElement>("[data-chart-overlay-host]") ?? parent;
    this.head.append(this.name, this.sub, this.venueAnchor, this.period, this.notice);
    this.name.setAttribute("role", "heading");
    this.name.setAttribute("aria-level", "2");
    this.notice.hidden = true;
    this.price.row.dataset.priceRow = "";
    this.ohlc.dataset.ohlc = "";
    this.price.fields.fetched.title = "키움에서 조회한 값입니다. 체결마다 바뀌지 않습니다.";
    this.price.fields.stalled.title = "실시간 시세가 멈췄습니다. 마지막으로 받은 값입니다.";
    this.venueAndOhlc.append(this.ohlc);
    this.ohlcLine.append(this.venueAndOhlc);
    this.body.append(this.price.row, this.ohlcLine);
    this.root.append(this.head, this.body);
    parent.append(this.root);
    this.presentationResize = new ResizeObserver(() => this.fit("geometry"));
    this.presentationResize.observe(parent);
    this.presentationMutations = new MutationObserver(() => this.fit("content"));
    this.presentationMutations.observe(this.venueAnchor, { subtree: true, childList: true, characterData: true, attributes: true });
    this.toolbarMutations = new MutationObserver((records) => {
      if (records.some((record) => record.type === "attributes" || [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && node.matches(".drawing-toolbar")))) this.fit("geometry");
    });
    this.toolbarMutations.observe(this.host, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-moved", "data-dock-normal"] });
    document.fonts.addEventListener("loadingdone", this.fontsChanged);
    void document.fonts.ready.then(this.fontsChanged);
  }

  setHead(h: { name: string; sub: string; period: string }): void {
    if (this.name.textContent === h.name && this.sub.textContent === h.sub && this.period.textContent === h.period) return;
    this.name.textContent = h.name;
    this.name.setAttribute("aria-label", h.name);
    this.sub.textContent = h.sub;
    this.period.textContent = h.period;
    this.fit("content");
  }

  /** 머리줄 끝의 짧은 안내(구독 오류). null이면 숨긴다. */
  setNotice(text: string | null): void {
    if (this.notice.textContent === (text ?? "") && this.notice.hidden === (text === null)) return;
    this.notice.textContent = text ?? "";
    this.notice.hidden = text === null;
    this.fit("content");
  }

  setDisplay(display: LegendDisplay): void {
    if (display.showLegend === this.display.showLegend && display.showOhlcChange === this.display.showOhlcChange) return;
    const moved = display.showLegend !== this.display.showLegend;
    this.display = { showLegend: display.showLegend, showOhlcChange: display.showOhlcChange };
    this.fit("content");
    if (!moved) return;
    this.head.hidden = !display.showLegend;
    this.body.hidden = !display.showLegend;
    if (display.showLegend) {
      this.period.before(this.venueAnchor);
      this.head.append(this.notice);
      this.price.row.after(this.ohlcLine);
    } else {
      this.ohlc.before(this.venueAnchor);
      this.ohlcLine.append(this.notice);
      this.head.after(this.ohlcLine);
    }
  }

  show(v: LegendBar | null): void {
    this.price.row.hidden = v === null;
    this.ohlc.hidden = v === null;
    this.ohlcLine.hidden = v === null && this.display.showLegend;
    const { showOhlcChange: withChange } = this.display;
    const classes = ohlcClasses(this.display);
    this.ohlcLine.className = classes.line;
    this.venueAndOhlc.className = classes.group;
    this.ohlc.className = classes.values;
    if (!v) return;
    const parts = legendParts(v);
    const dir = DIR_CLASS[parts.dir];
    this.price.fields.close.textContent = parts.close;
    this.price.fields.close.className = `text-xl font-semibold tracking-[-0.02em] ${dir}${v.stalledAt === null ? "" : " opacity-70"}`;
    const status = statusParts(v);
    this.price.fields.stalled.hidden = status.stalled === "";
    this.price.fields.stalled.textContent = status.stalled;
    this.price.fields.change.textContent = parts.change;
    this.price.fields.change.className = `text-s whitespace-pre ${dir}`;
    this.price.fields.time.textContent = parts.time;
    this.price.fields.fetched.hidden = status.fetched === "";
    const ohlcContent = JSON.stringify([parts.cells, withChange]);
    if (ohlcContent === this.ohlcContent) return;
    this.ohlcContent = ohlcContent;
    this.ohlc.replaceChildren(...parts.cells.map((cell) => ohlcCell(cell, withChange).root));
  }

  setLayoutBars(bars: readonly LegendBar[]): void {
    const layout = emptyAlternatives();
    layout.present = bars.length > 0;
    for (const bar of bars) {
      const parts = legendParts(bar);
      const status = statusParts(bar);
      layout.price.close.push(parts.close);
      layout.price.change.push(parts.change);
      layout.price.time.push(parts.time);
      if (status.fetched) layout.price.fetched.push(status.fetched);
      if (status.stalled) layout.price.stalled.push(status.stalled);
      parts.cells.forEach(([label, value, change], i) => {
        const field = layout.cells[i] ?? { label, values: [] };
        if (!layout.cells[i]) layout.cells.push(field);
        field.values.push(`${value}${this.display.showOhlcChange && change ? ` (${change.text})` : ""}`);
      });
    }
    this.layout = layout;
    this.fit("content");
  }

  fit(change: LayoutChange): void {
    if (change === "content") this.presentation = { kind: "invalidated" };
    if (this.disposed || this.presentationFrame !== null) return;
    this.presentationFrame = requestAnimationFrame(() => {
      this.presentationFrame = null;
      this.refreshPresentation();
    });
  }

  private readGeometryInputs(): LegendGeometryInputs {
    const viewport = this.presentationHost.readViewport();
    const toolbar = this.host.querySelector<HTMLElement>(".drawing-toolbar");
    return {
      desktop: !matchMedia("(width < 48rem)").matches,
      chart: geometryBox(this.parent),
      host: geometryBox(this.host),
      viewport: { axisWidth: viewport.axisWidth, pricePane: viewport.pricePane ? { top: viewport.pricePane.top, height: viewport.pricePane.height } : null },
      toolbar: toolbar ? { element: toolbar, normal: toolbar.dataset.dockNormal ?? "", moved: !!toolbar.dataset.moved, visible: toolbar.offsetParent !== null } : null,
    };
  }

  private contentBounds(root: HTMLElement): { right: number; bottom: number } {
    const box = root.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(root);
    const boxes = [...range.getClientRects(), ...[...root.querySelectorAll("*")].flatMap((element) => [...element.getClientRects()])].filter((rect) => rect.width > 0 && rect.height > 0);
    return { right: Math.max(box.left, ...boxes.map((rect) => rect.right)), bottom: Math.max(box.top, ...boxes.map((rect) => rect.bottom)) };
  }

  private projection(): LegendProjection {
    const root = el("div", this.root.className);
    root.setAttribute("aria-hidden", "true");
    root.inert = true;
    root.style.visibility = "hidden";
    root.style.pointerEvents = "none";
    const head = this.head.cloneNode(true);
    const body = el("div", this.body.className);
    body.hidden = !this.display.showLegend;
    const price = priceFields();
    price.row.hidden = !this.layout.present;
    const field = (name: keyof PriceAlternatives): LegendField => {
      const element = price.fields[name];
      const alternatives = this.layout.price[name];
      element.hidden = alternatives.length === 0;
      element.textContent = alternatives[0] ?? "";
      return { element, alternatives };
    };
    const fields = [field("close"), field("change"), field("time"), field("fetched"), field("stalled")];
    const classes = ohlcClasses(this.display);
    const line = el("div", classes.line);
    const group = el("div", classes.group);
    const ohlc = el("div", classes.values);
    ohlc.dataset.ohlc = "";
    ohlc.hidden = !this.layout.present;
    line.hidden = !this.layout.present && this.display.showLegend;
    for (const { label, values } of this.layout.cells) {
      const cell = ohlcCell([label, values[0] ?? "", null], false);
      const slot = el("span", "", values[0] ?? "");
      cell.root.replaceChildren(cell.name, slot);
      ohlc.append(cell.root);
      fields.push({ element: slot, alternatives: values });
    }
    if (!this.display.showLegend) group.append(this.venueAnchor.cloneNode(true));
    group.append(ohlc);
    line.append(group);
    if (!this.display.showLegend) line.append(this.notice.cloneNode(true));
    body.append(price.row);
    if (this.display.showLegend) body.append(line);
    for (const projected of this.presentationHost.projectRows()) {
      body.append(projected.root);
      fields.push(...projected.fields);
    }
    root.append(head);
    if (!this.display.showLegend) root.append(line);
    root.append(body);
    return { root, fields };
  }

  private refreshPresentation(): void {
    const inputs = this.readGeometryInputs();
    if (this.presentation.kind === "settled" && sameGeometryInputs(this.presentation.inputs, inputs)) return;
    this.presentation = { kind: "invalidated" };
    const { viewport, chart: chartBox, host: hostBox } = inputs;
    const toolbar = inputs.toolbar?.element;
    const scroll = toolbar?.scrollLeft ?? 0;
    const set = (name: string, value: string) => {
      if (this.host.style.getPropertyValue(name) !== value) this.host.style.setProperty(name, value);
    };
    const normal = () => {
      if (this.host.dataset.legendDensity) delete this.host.dataset.legendDensity;
      delete this.host.dataset.legendBeside;
      set("--legend-shift", "0px");
    };
    normal();
    if (!inputs.desktop || !viewport.pricePane) {
      this.presentation = { kind: "settled", inputs };
      return;
    }
    const projection = this.projection();
    this.parent.append(projection.root);
    try {
      reserveLegendFields(projection.fields);
      let shift = 0;
      if (toolbar && inputs.toolbar?.visible) {
        const [left, top, width, height] = inputs.toolbar.normal.split(",").map(Number);
        if (left === undefined || top === undefined || width === undefined || height === undefined || ![left, top, width, height].every(Number.isFinite)) return;
        const bar = { left: hostBox.x + left, top: hostBox.y + top, right: hostBox.x + left + width, bottom: hostBox.y + top + height };
        const range = document.createRange();
        const rows = [...projection.root.children].flatMap((child) => getComputedStyle(child).flexDirection === "column" ? [...child.children] : [child]);
        if (rows.some((row) => {
          range.selectNodeContents(row);
          const text = range.getBoundingClientRect();
          return text.width > 0 && text.top < bar.bottom && text.right + 8 > bar.left;
        })) shift = height;
      }
      const bounds = this.contentBounds(projection.root);
      const paneBottom = chartBox.y + viewport.pricePane.top + viewport.pricePane.height;
      if (bounds.bottom + shift > paneBottom + 0.5) {
        this.host.dataset.legendDensity = "compact";
        set("--legend-shift", "0px");
        reserveLegendFields(projection.fields);
        const compact = this.contentBounds(projection.root);
        const left = compact.right - hostBox.x + 8;
        const width = (chartBox.x + chartBox.width) - hostBox.x - viewport.axisWidth - 8 - left;
        const grip = toolbar?.querySelector(".draw-grip");
        const tools = [...this.host.querySelectorAll(".drawing-toolbar .draw-tool")];
        if (toolbar && grip && tools.length > 0) {
          const style = getComputedStyle(toolbar);
          const minimum = grip.getBoundingClientRect().width + Math.max(...tools.map((tool) => tool.getBoundingClientRect().width)) + parseFloat(style.columnGap) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
          if (width >= minimum) {
            this.host.dataset.legendBeside = "";
            set("--legend-dock-left", `${left}px`);
            set("--legend-dock-width", `${width}px`);
          }
        }
        if (toolbar && !this.host.hasAttribute("data-legend-beside")) normal();
      }
      if (!this.host.hasAttribute("data-legend-beside") && !inputs.toolbar?.moved) set("--legend-shift", `${shift}px`);
      if (!this.host.hasAttribute("data-legend-beside")) for (const name of ["--legend-dock-left", "--legend-dock-width"]) this.host.style.removeProperty(name);
    } finally {
      projection.root.remove();
    }
    if (toolbar) toolbar.scrollLeft = scroll;
    this.presentation = { kind: "settled", inputs };
  }

  dispose(): void {
    this.disposed = true;
    document.fonts.removeEventListener("loadingdone", this.fontsChanged);
    if (this.presentationFrame !== null) cancelAnimationFrame(this.presentationFrame);
    this.presentationResize.disconnect();
    this.presentationMutations.disconnect();
    this.toolbarMutations.disconnect();
    delete this.host.dataset.legendDensity;
    delete this.host.dataset.legendBeside;
    for (const name of ["--legend-shift", "--legend-dock-left", "--legend-dock-width"]) this.host.style.removeProperty(name);
    this.root.remove();
  }
}
