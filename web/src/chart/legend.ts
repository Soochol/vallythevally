import type { Bar } from "../api/generated/Bar";
import type { Period } from "../api/generated/Period";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import { type Direction, direction, formatChange, formatPercent, formatPrice } from "../lib/format";
import type { PaneBounds } from "./indicators/legendRows";
import { denserTier, legendTier, reserveLegendFields, type LegendField, type LegendProjection, type LegendTier } from "./legendProjection";
import { OptionalTrackedValues, TrackedValues, valueShape } from "./legendShapes";
import type { ChartSettings } from "./settings";
import { formatBarTime, formatKstClock } from "./time";

const ROW_SURFACE = "pr-1 rounded-s bg-[color-mix(in_srgb,var(--chart-bg)_78%,transparent)]";
const ROW = `w-max ${ROW_SURFACE}`;
const OHLC_LINE = `relative z-[6] flex items-center ${ROW_SURFACE} max-md:w-auto`;
const OHLC = "flex flex-wrap gap-x-3 whitespace-nowrap text-s max-md:gap-x-1.5";
const VENUE_AND_OHLC = "flex min-w-0 items-baseline gap-x-2 gap-y-1 [&>:empty]:hidden";
const OHLC_ALONE = { line: `w-max ${OHLC_LINE}`, group: VENUE_AND_OHLC, values: OHLC };
const OHLC_ALONE_WITH_CHANGE = { ...OHLC_ALONE, line: `w-fit max-w-full ${OHLC_LINE}` };
const OHLC_WITH_VENUE_AND_NOTICE = {
  line: `w-fit max-w-full flex-wrap gap-x-2 gap-y-1 ${OHLC_LINE}`,
  group: `flex-wrap ${VENUE_AND_OHLC}`,
  values: `grow basis-0 ${OHLC}`,
};
const DIR_CLASS = { up: "text-up", down: "text-down", flat: "text-text-2" } as const;
const STATUS_PILL = "self-center rounded-s border px-1.5 text-xs";
const NEUTRAL_PILL = `${STATUS_PILL} border-line text-text-2`;
const WARNING_PILL = `${STATUS_PILL} border-warning text-warning`;

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
    fetched: el("span", NEUTRAL_PILL, "조회 값"),
    stalled: el("span", WARNING_PILL),
  };
  row.append(fields.close, fields.change, fields.time, fields.fetched, fields.stalled);
  return { row, fields };
}

function ohlcClasses({ showLegend, showOhlcChange }: LegendDisplay) {
  return !showLegend ? OHLC_WITH_VENUE_AND_NOTICE : showOhlcChange ? OHLC_ALONE_WITH_CHANGE : OHLC_ALONE;
}

interface OhlcCellEls {
  root: HTMLSpanElement;
  name: HTMLElement;
  valueNode: Text;
  spaceNode: Text;
  change: HTMLSpanElement;
  label: string;
  value: string;
  changeText: string;
  changeClass: string;
  changeShown: boolean;
}

function ohlcLabel(label: string) {
  return el("i", "mr-[3px] not-italic text-text-2", label);
}

function createOhlcCell([label, value, change]: LegendParts["cells"][number], withChange: boolean): OhlcCellEls {
  const root = el("span", "");
  const name = ohlcLabel(label);
  const valueNode = document.createTextNode(value);
  const spaceNode = document.createTextNode(" ");
  const changeShown = Boolean(change && withChange);
  const changeClass = change ? DIR_CLASS[change.dir] : "";
  const changeText = change ? `(${change.text})` : "";
  const changeEl = el("span", changeClass, changeText);
  root.append(name, valueNode);
  if (changeShown) root.append(spaceNode, changeEl);
  return { root, name, valueNode, spaceNode, change: changeEl, label, value, changeText, changeClass, changeShown };
}

function syncOhlcCell(cell: OhlcCellEls, [label, value, change]: LegendParts["cells"][number], withChange: boolean): void {
  if (cell.label !== label) {
    cell.label = label;
    cell.name.textContent = label;
  }
  if (cell.value !== value) {
    cell.value = value;
    cell.valueNode.data = value;
  }
  if (withChange && change) {
    const nextClass = DIR_CLASS[change.dir];
    const nextText = `(${change.text})`;
    if (cell.changeClass !== nextClass) {
      cell.changeClass = nextClass;
      cell.change.className = nextClass;
    }
    if (cell.changeText !== nextText) {
      cell.changeText = nextText;
      cell.change.textContent = nextText;
    }
    if (!cell.changeShown) {
      cell.changeShown = true;
      cell.root.append(cell.spaceNode, cell.change);
    }
  } else if (cell.changeShown) {
    cell.changeShown = false;
    cell.spaceNode.remove();
    cell.change.remove();
  }
}

function statusParts(value: LegendBar) {
  return { fetched: value.isCurrent ? "조회 값" : "", stalled: value.stalledAt === null ? "" : `멈춤 ${formatKstClock(value.stalledAt)}` };
}

type PriceAlternatives = {
  close: TrackedValues;
  change: TrackedValues;
  time: TrackedValues;
  fetched: OptionalTrackedValues;
  stalled: OptionalTrackedValues;
};
type LayoutAlternatives = { price: PriceAlternatives; cells: { label: string; values: TrackedValues }[]; present: boolean; count: number };

function emptyAlternatives(): LayoutAlternatives {
  return {
    price: {
      close: new TrackedValues(),
      change: new TrackedValues(),
      time: new TrackedValues(),
      fetched: new OptionalTrackedValues(),
      stalled: new OptionalTrackedValues(),
    },
    cells: [],
    present: false,
    count: 0,
  };
}

type LegendViewport = { readonly pricePane: PaneBounds | null; readonly axisWidth: number };
export type LegendBox = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
type LegendHost = {
  readonly projectRows: () => readonly LegendProjection[];
  readonly readViewport: () => LegendViewport;
  readonly applyTier: (tier: LegendTier) => void;
  readonly reserveTop: (legendBottom: number, paneHeight: number) => void;
};
type GeometryBox = Pick<DOMRectReadOnly, "x" | "y" | "width" | "height">;
type LegendGeometryInputs = {
  readonly desktop: boolean;
  readonly chart: GeometryBox;
  readonly viewport: LegendViewport;
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
  return first.desktop === second.desktop && sameBox(first.chart, second.chart)
    && first.viewport.axisWidth === second.viewport.axisWidth
    && first.viewport.pricePane?.top === second.viewport.pricePane?.top && first.viewport.pricePane?.height === second.viewport.pricePane?.height;
}

/**
 * 칸 왼쪽 위 범례(frontend.md §2.3). React가 아니라 컨트롤러가 DOM을 직접 고친다.
 * 휴대폰에서는 머리줄과 가격줄을 휴대폰 머리가 대신하므로 숨긴다(§4).
 */
export class Legend {
  readonly root = el("div", "chart-legend pointer-events-none absolute left-5 top-4 flex max-w-[calc(100%-90px)] flex-col gap-2");
  readonly body = el("div", "relative z-[4] flex min-w-0 flex-col gap-2");
  private readonly name = el("span", "pointer-events-none min-w-0 truncate text-l font-semibold");
  private readonly sub = el("span", "flex-none text-s text-text-3");
  readonly venueAnchor = el("span", "inline-flex flex-none max-md:hidden");
  private readonly period = el("span", "flex-none text-s text-text-3");
  private readonly regularBadge = el("span", `${NEUTRAL_PILL} flex-none max-md:hidden`, "정규장");
  private readonly price = priceFields();
  private readonly notice = el("span", `${WARNING_PILL} break-keep max-md:hidden`);
  private readonly head = el("div", "relative z-[6] flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-s bg-[color-mix(in_srgb,var(--chart-bg)_78%,transparent)] pr-1");
  private readonly ohlcLine = el("div", OHLC_ALONE.line);
  private readonly venueAndOhlc = el("div", OHLC_ALONE.group);
  private readonly ohlc = el("div", OHLC_ALONE.values);
  private display: LegendDisplay = { showLegend: true, showOhlcChange: false };
  private ohlcCells: OhlcCellEls[] = [];
  private lastShownBar: Bar | null = null;
  private lastShownPrev: Bar | null = null;
  private lastShownIsCurrent = false;
  private lastShownIsIndex = false;
  private lastShownPeriod: Period | null = null;
  private lastShownStalledAt: UnixSeconds | null = null;
  private lastShownLegend = true;
  private lastShownOhlcChange = false;
  private lastCloseText = "";
  private lastCloseClass = "";
  private lastChangeText = "";
  private lastChangeClass = "";
  private lastTimeText = "";
  private lastStalledText = "";
  private lastStalledHidden: boolean | null = null;
  private lastFetchedHidden: boolean | null = null;
  private lastPriceHidden: boolean | null = null;
  private lastOhlcHidden: boolean | null = null;
  private lastOhlcLineHidden: boolean | null = null;
  private lastOhlcLineClass = OHLC_ALONE.line;
  private lastVenueAndOhlcClass = OHLC_ALONE.group;
  private lastOhlcClass = OHLC_ALONE.values;
  private layout = emptyAlternatives();
  private readonly seenTailShapes = new Map<string, Set<string>>();
  private active = true;
  private deferredFit: LayoutChange | null = null;

  private readonly host: HTMLElement;
  private readonly presentationResize: ResizeObserver;
  private readonly presentationMutations: MutationObserver;
  private readonly phoneMedia: MediaQueryList;
  private phone: boolean;
  private presentation: PresentationState = { kind: "invalidated" };
  private presentationFrame: number | null = null;
  private tier: LegendTier = "compact";
  private avoidBox: LegendBox | null = null;
  private pointed = false;
  private disposed = false;
  private readonly fontsChanged = () => this.fit("content");
  private readonly onPhoneChange = () => {
    this.phone = this.phoneMedia.matches;
    this.fit("geometry");
  };

  constructor(private readonly parent: HTMLElement, private readonly presentationHost: LegendHost) {
    this.host = parent.closest<HTMLElement>("[data-chart-overlay-host]") ?? parent;
    this.phoneMedia = matchMedia("(width < 48rem)");
    this.phone = this.phoneMedia.matches;
    this.phoneMedia.addEventListener("change", this.onPhoneChange);
    this.head.dataset.legendHead = "";
    this.sub.dataset.legendSub = "";
    this.period.dataset.legendPeriod = "";
    this.regularBadge.dataset.regularHoursBadge = "";
    this.regularBadge.title = "정규장(09:00~15:30) 봉만 표시 중";
    this.regularBadge.hidden = true;
    this.ohlcLine.dataset.ohlcLine = "";
    this.head.append(this.name, this.sub, this.venueAnchor, this.period, this.regularBadge, this.price.row, this.notice);
    this.name.setAttribute("role", "heading");
    this.name.setAttribute("aria-level", "2");
    this.notice.hidden = true;
    this.price.row.dataset.priceRow = "";
    this.ohlc.dataset.ohlc = "";
    this.price.fields.fetched.title = "실시간이 아니라 조회로 받은 값";
    this.price.fields.stalled.title = "실시간 시세가 멈췄습니다. 마지막으로 받은 값입니다.";
    this.venueAndOhlc.append(this.ohlc);
    this.ohlcLine.append(this.venueAndOhlc);
    this.body.append(this.ohlcLine);
    this.root.append(this.head, this.body);
    parent.append(this.root);
    this.presentationResize = new ResizeObserver(() => this.fit("geometry"));
    this.presentationResize.observe(parent);
    this.presentationMutations = new MutationObserver(() => this.fit("content"));
    this.presentationMutations.observe(this.venueAnchor, { subtree: true, childList: true, characterData: true, attributes: true });
    document.fonts.addEventListener("loadingdone", this.fontsChanged);
    void document.fonts.ready.then(this.fontsChanged);
  }

  setLeftAxisWidth(width: number): void {
    const nextLeft = width > 0 ? `${width + 16}px` : "";
    const nextMaxWidth = width > 0 ? `calc(100% - ${width + 90}px)` : "";
    if (this.root.style.left !== nextLeft) this.root.style.left = nextLeft;
    if (this.root.style.maxWidth !== nextMaxWidth) this.root.style.maxWidth = nextMaxWidth;
  }

  setHead(h: { name: string; sub: string; period: string; regularHoursOnly?: boolean }): void {
    const regularHidden = !h.regularHoursOnly;
    if (this.name.textContent === h.name && this.sub.textContent === h.sub && this.period.textContent === h.period && this.regularBadge.hidden === regularHidden) return;
    this.name.textContent = h.name;
    this.name.setAttribute("aria-label", h.name);
    this.sub.textContent = h.sub;
    this.period.textContent = h.period;
    this.regularBadge.hidden = regularHidden;
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
    this.root.toggleAttribute("data-bare", !display.showLegend);
    this.head.hidden = !display.showLegend;
    this.body.hidden = !display.showLegend;
    if (display.showLegend) {
      this.period.before(this.venueAnchor);
      this.head.append(this.notice);
      this.mountPriceRow();
    } else {
      this.ohlc.before(this.venueAnchor);
      this.ohlcLine.append(this.notice);
      this.head.after(this.ohlcLine);
    }
  }

  get avoid(): LegendBox | null {
    return this.avoidBox;
  }

  private mountPriceRow(): void {
    if (!this.display.showLegend) return;
    this.notice.before(this.price.row);
    this.body.prepend(this.ohlcLine);
  }

  show(v: LegendBar | null, pointed = false): void {
    if (
      v !== null
      && this.pointed === pointed
      && v.bar === this.lastShownBar
      && v.prev === this.lastShownPrev
      && v.isCurrent === this.lastShownIsCurrent
      && v.isIndex === this.lastShownIsIndex
      && v.period === this.lastShownPeriod
      && v.stalledAt === this.lastShownStalledAt
      && this.display.showLegend === this.lastShownLegend
      && this.display.showOhlcChange === this.lastShownOhlcChange
    ) {
      return;
    }
    if (this.pointed !== pointed) {
      this.pointed = pointed;
      this.root.toggleAttribute("data-pointed", pointed);
    }
    const empty = v === null;
    if (this.lastPriceHidden !== empty) {
      this.lastPriceHidden = empty;
      this.price.row.hidden = empty;
    }
    if (this.lastOhlcHidden !== empty) {
      this.lastOhlcHidden = empty;
      this.ohlc.hidden = empty;
    }
    const lineHidden = empty && this.display.showLegend;
    if (this.lastOhlcLineHidden !== lineHidden) {
      this.lastOhlcLineHidden = lineHidden;
      this.ohlcLine.hidden = lineHidden;
    }
    const { showOhlcChange: withChange } = this.display;
    const classes = ohlcClasses(this.display);
    if (this.lastOhlcLineClass !== classes.line) {
      this.lastOhlcLineClass = classes.line;
      this.ohlcLine.className = classes.line;
    }
    if (this.lastVenueAndOhlcClass !== classes.group) {
      this.lastVenueAndOhlcClass = classes.group;
      this.venueAndOhlc.className = classes.group;
    }
    if (this.lastOhlcClass !== classes.values) {
      this.lastOhlcClass = classes.values;
      this.ohlc.className = classes.values;
    }
    this.lastShownLegend = this.display.showLegend;
    this.lastShownOhlcChange = withChange;
    if (!v) {
      this.lastShownBar = null;
      return;
    }
    this.lastShownBar = v.bar;
    this.lastShownPrev = v.prev;
    this.lastShownIsCurrent = v.isCurrent;
    this.lastShownIsIndex = v.isIndex;
    this.lastShownPeriod = v.period;
    this.lastShownStalledAt = v.stalledAt;
    const parts = legendParts(v);
    const dir = DIR_CLASS[parts.dir];
    if (this.lastCloseText !== parts.close) {
      this.lastCloseText = parts.close;
      this.price.fields.close.textContent = parts.close;
    }
    const closeClass = `text-xl font-semibold tracking-[-0.02em] ${dir}${v.stalledAt === null ? "" : " opacity-70"}`;
    if (this.lastCloseClass !== closeClass) {
      this.lastCloseClass = closeClass;
      this.price.fields.close.className = closeClass;
    }
    const status = statusParts(v);
    const stalledHidden = status.stalled === "";
    if (this.lastStalledHidden !== stalledHidden) {
      this.lastStalledHidden = stalledHidden;
      this.price.fields.stalled.hidden = stalledHidden;
    }
    if (this.lastStalledText !== status.stalled) {
      this.lastStalledText = status.stalled;
      this.price.fields.stalled.textContent = status.stalled;
    }
    if (this.lastChangeText !== parts.change) {
      this.lastChangeText = parts.change;
      this.price.fields.change.textContent = parts.change;
    }
    const changeClass = `text-s whitespace-pre ${dir}`;
    if (this.lastChangeClass !== changeClass) {
      this.lastChangeClass = changeClass;
      this.price.fields.change.className = changeClass;
    }
    if (this.lastTimeText !== parts.time) {
      this.lastTimeText = parts.time;
      this.price.fields.time.textContent = parts.time;
    }
    const fetchedHidden = status.fetched === "";
    if (this.lastFetchedHidden !== fetchedHidden) {
      this.lastFetchedHidden = fetchedHidden;
      this.price.fields.fetched.hidden = fetchedHidden;
    }
    if (this.ohlcCells.length !== parts.cells.length) {
      this.ohlcCells = parts.cells.map((cell) => createOhlcCell(cell, withChange));
      this.ohlc.replaceChildren(...this.ohlcCells.map((cell) => cell.root));
      return;
    }
    for (let i = 0; i < parts.cells.length; i++) {
      syncOhlcCell(this.ohlcCells[i]!, parts.cells[i]!, withChange);
    }
  }

  setLayoutBars(bars: readonly LegendBar[]): void {
    const layout = emptyAlternatives();
    this.seenTailShapes.clear();
    layout.present = bars.length > 0;
    layout.count = bars.length;
    for (let i = 0; i < bars.length; i++) this.putLayoutBar(layout, i, bars[i]!, false);
    this.layout = layout;
    this.fit("content");
  }

  updateLayoutTail(from: number, bars: readonly LegendBar[]): boolean {
    if (from < 0 || from > this.layout.count || (from === 0 && !this.layout.present)) {
      this.setLayoutBars(bars);
      return true;
    }
    let changed = false;
    for (let offset = 0; offset < bars.length; offset++) {
      if (this.putLayoutBar(this.layout, from + offset, bars[offset]!, true)) changed = true;
    }
    const nextCount = from + bars.length;
    if (nextCount < this.layout.count && this.truncateLayout(this.layout, nextCount)) changed = true;
    this.layout.count = nextCount;
    const nextPresent = nextCount > 0;
    if (this.layout.present !== nextPresent) {
      this.layout.present = nextPresent;
      changed = true;
    }
    return changed;
  }

  private recordTailShape(slot: string, text: string): boolean {
    if (text === "") return false;
    const shape = valueShape(text);
    let set = this.seenTailShapes.get(slot);
    if (!set) {
      set = new Set();
      this.seenTailShapes.set(slot, set);
    }
    if (set.has(shape)) return false;
    set.add(shape);
    return true;
  }

  private putLayoutBar(layout: LayoutAlternatives, index: number, bar: LegendBar, tailOnly: boolean): boolean {
    const parts = legendParts(bar);
    const status = statusParts(bar);
    let changed = false;
    const closeChanged = layout.price.close.setAt(index, parts.close);
    const changeChanged = layout.price.change.setAt(index, parts.change);
    const timeChanged = layout.price.time.setAt(index, parts.time);
    const fetchedChanged = layout.price.fetched.setAt(index, status.fetched);
    const stalledChanged = layout.price.stalled.setAt(index, status.stalled);
    const closeNew = this.recordTailShape("close", parts.close);
    const changeNew = this.recordTailShape("change", parts.change);
    const timeNew = this.recordTailShape("time", parts.time);
    const fetchedNew = this.recordTailShape("fetched", status.fetched);
    const stalledNew = this.recordTailShape("stalled", status.stalled);
    if (tailOnly) {
      if (closeNew || changeNew || timeNew || fetchedNew || stalledNew) changed = true;
    } else if (closeChanged || changeChanged || timeChanged || fetchedChanged || stalledChanged) {
      changed = true;
    }
    for (let i = 0; i < parts.cells.length; i++) {
      const [label, value, change] = parts.cells[i]!;
      let field = layout.cells[i];
      if (!field) {
        field = { label, values: new TrackedValues() };
        layout.cells.push(field);
        changed = true;
      }
      const text = `${value}${this.display.showOhlcChange && change ? ` (${change.text})` : ""}`;
      const cellChanged = field.values.setAt(index, text);
      const cellNew = this.recordTailShape(`cell:${i}`, text);
      if (tailOnly ? cellNew : cellChanged) changed = true;
    }
    return changed;
  }

  private truncateLayout(layout: LayoutAlternatives, length: number): boolean {
    let changed = false;
    if (layout.price.close.truncate(length)) changed = true;
    if (layout.price.change.truncate(length)) changed = true;
    if (layout.price.time.truncate(length)) changed = true;
    if (layout.price.fetched.truncate(length)) changed = true;
    if (layout.price.stalled.truncate(length)) changed = true;
    for (const cell of layout.cells) if (cell.values.truncate(length)) changed = true;
    return changed;
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (!active) {
      if (this.presentationFrame !== null) {
        cancelAnimationFrame(this.presentationFrame);
        this.presentationFrame = null;
        this.deferredFit = this.deferredFit === "content" ? "content" : "geometry";
      }
      return;
    }
    if (this.deferredFit !== null) {
      const change = this.deferredFit;
      this.deferredFit = null;
      this.fit(change);
    }
  }

  fit(change: LayoutChange): void {
    if (change === "content") this.presentation = { kind: "invalidated" };
    if (this.disposed) return;
    if (!this.active) {
      this.deferredFit = this.deferredFit === "content" || change === "content" ? "content" : "geometry";
      return;
    }
    if (this.presentationFrame !== null) return;
    this.presentationFrame = requestAnimationFrame(() => {
      this.presentationFrame = null;
      this.refreshPresentation();
    });
  }

  private readGeometryInputs(): LegendGeometryInputs {
    const viewport = this.presentationHost.readViewport();
    return {
      desktop: !this.phone,
      chart: geometryBox(this.parent),
      viewport: { axisWidth: viewport.axisWidth, pricePane: viewport.pricePane ? { top: viewport.pricePane.top, height: viewport.pricePane.height } : null },
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
    const head = this.head.cloneNode(true) as HTMLElement;
    head.querySelector("[data-price-row]")?.remove();
    const body = el("div", this.body.className);
    body.hidden = !this.display.showLegend;
    const price = priceFields();
    price.row.hidden = !this.layout.present;
    const field = (name: keyof PriceAlternatives): LegendField => {
      const element = price.fields[name];
      const alternatives = this.layout.price[name].values;
      element.hidden = alternatives.length === 0;
      element.textContent = alternatives[0] ?? "";
      return { element, alternatives };
    };
    const fields = [field("close"), field("change"), field("time"), field("fetched"), field("stalled")];
    const classes = ohlcClasses(this.display);
    const line = el("div", classes.line);
    line.dataset.ohlcLine = "";
    const group = el("div", classes.group);
    const ohlc = el("div", classes.values);
    ohlc.dataset.ohlc = "";
    ohlc.hidden = !this.layout.present;
    line.hidden = !this.layout.present && this.display.showLegend;
    for (const { label, values } of this.layout.cells) {
      const alternatives = values.values;
      const root = el("span", "");
      const slot = el("span", "", alternatives[0] ?? "");
      root.append(ohlcLabel(label), slot);
      ohlc.append(root);
      fields.push({ element: slot, alternatives });
    }
    if (!this.display.showLegend) group.append(this.venueAnchor.cloneNode(true));
    group.append(ohlc);
    line.append(group);
    if (!this.display.showLegend) line.append(this.notice.cloneNode(true));
    if (this.display.showLegend) {
      head.append(price.row);
      body.append(line);
    }
    for (const projected of this.presentationHost.projectRows()) {
      body.append(projected.root);
      fields.push(...projected.fields);
    }
    root.append(head);
    if (!this.display.showLegend) root.append(line);
    root.append(body);
    return { root, fields };
  }

  private applyTier(tier: LegendTier, desktop: boolean): void {
    this.tier = tier;
    if (this.host.dataset.legendTier !== tier) this.host.dataset.legendTier = tier;
    if (desktop) {
      if (this.host.dataset.legendDensity !== "compact") this.host.dataset.legendDensity = "compact";
    } else delete this.host.dataset.legendDensity;
    this.presentationHost.applyTier(tier);
    this.mountPriceRow();
  }

  private refreshPresentation(): void {
    const inputs = this.readGeometryInputs();
    if (this.presentation.kind === "settled" && sameGeometryInputs(this.presentation.inputs, inputs)) return;
    this.presentation = { kind: "invalidated" };
    const { viewport, chart: chartBox } = inputs;
    if (!viewport.pricePane) {
      delete this.host.dataset.legendDensity;
      delete this.host.dataset.legendTier;
      this.avoidBox = null;
      this.presentation = { kind: "settled", inputs };
      return;
    }
    const paneBottom = chartBox.y + viewport.pricePane.top + viewport.pricePane.height;
    const plotRight = chartBox.x + chartBox.width - viewport.axisWidth;
    const measureProjection = () => {
      const projection = this.projection();
      this.parent.append(projection.root);
      reserveLegendFields(projection.fields);
      return { root: projection.root, content: this.contentBounds(projection.root), origin: projection.root.getBoundingClientRect() };
    };
    this.applyTier(legendTier({ chartWidth: chartBox.width, paneHeight: viewport.pricePane.height, phone: !inputs.desktop }), inputs.desktop);
    let measured = measureProjection();
    try {
      const nextFromCompact = this.tier === "compact" && (measured.content.right > plotRight + 0.5 || measured.content.bottom > paneBottom + 0.5) ? denserTier(this.tier) : null;
      if (nextFromCompact) {
        measured.root.remove();
        this.applyTier(nextFromCompact, inputs.desktop);
        measured = measureProjection();
      }
      this.avoidBox = { left: measured.origin.left - chartBox.x, top: measured.origin.top - chartBox.y, right: measured.content.right - chartBox.x, bottom: measured.content.bottom - chartBox.y };
    } finally {
      measured.root.remove();
    }
    this.presentationHost.reserveTop(this.avoidBox.bottom - viewport.pricePane.top, viewport.pricePane.height);
    this.presentation = { kind: "settled", inputs };
  }

  dispose(): void {
    this.disposed = true;
    this.phoneMedia.removeEventListener("change", this.onPhoneChange);
    document.fonts.removeEventListener("loadingdone", this.fontsChanged);
    if (this.presentationFrame !== null) cancelAnimationFrame(this.presentationFrame);
    this.presentationResize.disconnect();
    this.presentationMutations.disconnect();
    delete this.host.dataset.legendDensity;
    delete this.host.dataset.legendTier;
    this.root.remove();
  }
}
