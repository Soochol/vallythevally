import type { Bar } from "../api/generated/Bar";
import type { Period } from "../api/generated/Period";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import { type Direction, direction, formatChange, formatPercent, formatPrice, formatVolume } from "../lib/format";
import type { PaneBounds } from "./indicators/legendRows";
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
  private readonly priceRow = el("div", `${ROW} flex items-baseline gap-2 whitespace-nowrap max-md:hidden`);
  private readonly close = el("span", "text-xl font-semibold tracking-[-0.02em]");
  private readonly change = el("span", "text-s");
  private readonly time = el("span", "text-xs text-text-2");
  private readonly fetched = el(
    "span",
    "self-center rounded-[9px] border border-line px-1.5 text-xs text-text-3",
    "조회 값",
  );
  private readonly stalled = el("span", "self-center rounded-[9px] border border-accent px-1.5 text-xs text-accent");
  private readonly notice = el("span", "break-keep text-xs text-accent max-md:hidden");
  private readonly head = el("div", "relative z-[6] flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-s bg-[color-mix(in_srgb,var(--chart-bg)_78%,transparent)] pr-1 max-md:hidden");
  private readonly ohlcLine = el("div", OHLC_ALONE.line);
  private readonly venueAndOhlc = el("div", OHLC_ALONE.group);
  private readonly ohlc = el("div", OHLC_ALONE.values);
  private display: LegendDisplay = { showLegend: true, showOhlcChange: false };
  private ohlcContent = "";

  private readonly host: HTMLElement;
  private readonly presentationResize: ResizeObserver;
  private readonly presentationMutations: MutationObserver;
  private readonly toolbarMutations: MutationObserver;
  private viewport: { pricePane: PaneBounds | null; axisWidth: number } | null = null;
  private presentationFrame: number | null = null;
  private finalGeometry = "";
  private disposed = false;
  private readonly fontsChanged = () => this.schedulePresentation();

  constructor(private readonly parent: HTMLElement) {
    this.host = parent.closest<HTMLElement>("[data-chart-overlay-host]") ?? parent;
    this.head.append(this.name, this.sub, this.venueAnchor, this.period, this.notice);
    this.name.setAttribute("role", "heading");
    this.name.setAttribute("aria-level", "2");
    this.notice.hidden = true;
    this.priceRow.dataset.priceRow = "";
    this.ohlc.dataset.ohlc = "";
    this.fetched.title = "키움에서 조회한 값입니다. 체결마다 바뀌지 않습니다.";
    this.stalled.title = "실시간 시세가 멈췄습니다. 마지막으로 받은 값입니다.";
    this.priceRow.append(this.close, this.change, this.time, this.fetched, this.stalled);
    this.venueAndOhlc.append(this.ohlc);
    this.ohlcLine.append(this.venueAndOhlc);
    this.body.append(this.priceRow, this.ohlcLine);
    this.root.append(this.head, this.body);
    parent.append(this.root);
    this.presentationResize = new ResizeObserver(() => {
      if (this.geometrySnapshot() !== this.finalGeometry) this.schedulePresentation();
    });
    this.presentationResize.observe(parent);
    this.presentationResize.observe(this.root);
    this.presentationMutations = new MutationObserver(() => this.schedulePresentation());
    this.presentationMutations.observe(this.root, { subtree: true, childList: true, characterData: true });
    this.toolbarMutations = new MutationObserver((records) => {
      if (records.some((record) => record.type === "attributes" || [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && node.matches(".drawing-toolbar")))) this.schedulePresentation();
    });
    this.toolbarMutations.observe(this.host, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-moved", "data-dock-normal"] });
    document.fonts.addEventListener("loadingdone", this.fontsChanged);
    void document.fonts.ready.then(this.fontsChanged);
  }

  setHead(h: { name: string; sub: string; period: string }): void {
    this.name.textContent = h.name;
    this.name.setAttribute("aria-label", h.name);
    this.sub.textContent = h.sub;
    this.period.textContent = h.period;
  }

  /** 머리줄 끝의 짧은 안내(구독 오류). null이면 숨긴다. */
  setNotice(text: string | null): void {
    this.notice.textContent = text ?? "";
    this.notice.hidden = text === null;
  }

  setDisplay(display: LegendDisplay): void {
    const moved = display.showLegend !== this.display.showLegend;
    this.display = display;
    if (!moved) return;
    this.head.hidden = !display.showLegend;
    this.body.hidden = !display.showLegend;
    if (display.showLegend) {
      this.period.before(this.venueAnchor);
      this.head.append(this.notice);
      this.priceRow.after(this.ohlcLine);
    } else {
      this.ohlc.before(this.venueAnchor);
      this.ohlcLine.append(this.notice);
      this.head.after(this.ohlcLine);
    }
  }

  show(v: LegendBar | null): void {
    this.priceRow.hidden = v === null;
    this.ohlc.hidden = v === null;
    this.ohlcLine.hidden = v === null && this.display.showLegend;
    const { showLegend, showOhlcChange: withChange } = this.display;
    const classes = !showLegend ? OHLC_WITH_VENUE_AND_NOTICE : withChange ? OHLC_ALONE_WITH_CHANGE : OHLC_ALONE;
    this.ohlcLine.className = classes.line;
    this.venueAndOhlc.className = classes.group;
    this.ohlc.className = classes.values;
    if (!v) return;
    const parts = legendParts(v);
    const dir = DIR_CLASS[parts.dir];
    this.close.textContent = parts.close;
    this.close.className = `text-xl font-semibold tracking-[-0.02em] ${dir}${v.stalledAt === null ? "" : " opacity-70"}`;
    this.stalled.hidden = v.stalledAt === null;
    this.stalled.textContent = v.stalledAt === null ? "" : `멈춤 ${formatKstClock(v.stalledAt)}`;
    this.change.textContent = parts.change;
    this.change.className = `text-s whitespace-pre ${dir}`;
    this.time.textContent = parts.time;
    this.fetched.hidden = !v.isCurrent;
    const ohlcContent = JSON.stringify([parts.cells, withChange]);
    if (ohlcContent === this.ohlcContent) return;
    this.ohlcContent = ohlcContent;
    this.ohlc.replaceChildren(
      ...parts.cells.map(([k, val, change]) => {
        const span = el("span", "");
        span.append(el("i", "mr-[3px] not-italic text-text-3", k), val);
        if (change && withChange) span.append(" ", el("span", DIR_CLASS[change.dir], `(${change.text})`));
        return span;
      }),
    );
  }

  fit(viewport: { pricePane: PaneBounds | null; axisWidth: number }): void {
    this.viewport = viewport;
    this.schedulePresentation();
  }

  private schedulePresentation(): void {
    if (this.disposed || this.presentationFrame !== null) return;
    this.presentationFrame = requestAnimationFrame(() => {
      this.presentationFrame = null;
      this.refreshPresentation();
    });
  }

  private geometrySnapshot(): string {
    return [this.parent, this.root, this.host.querySelector(".drawing-toolbar")].map((element) => {
      const box = element?.getBoundingClientRect();
      return box ? [box.x, box.y, box.width, box.height].join(",") : "";
    }).join(";");
  }

  private contentBounds(): { right: number; bottom: number } {
    const box = this.root.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(this.root);
    const boxes = [...range.getClientRects(), ...[...this.root.querySelectorAll("*")].flatMap((element) => [...element.getClientRects()])].filter((rect) => rect.width > 0 && rect.height > 0);
    return { right: Math.max(box.left, ...boxes.map((rect) => rect.right)), bottom: Math.max(box.top, ...boxes.map((rect) => rect.bottom)) };
  }

  private refreshPresentation(): void {
    const viewport = this.viewport;
    if (!viewport) return;
    const toolbar = this.host.querySelector<HTMLElement>(".drawing-toolbar");
    const scroll = toolbar?.scrollLeft ?? 0;
    const hostBox = this.host.getBoundingClientRect();
    const chartBox = this.parent.getBoundingClientRect();
    const set = (name: string, value: string) => {
      if (this.host.style.getPropertyValue(name) !== value) this.host.style.setProperty(name, value);
    };
    const normal = () => {
      if (this.host.dataset.legendDensity) delete this.host.dataset.legendDensity;
      set("--legend-shift", "0px");
    };
    normal();
    if (matchMedia("(width < 48rem)").matches || !viewport.pricePane) {
      this.finalGeometry = this.geometrySnapshot();
      return;
    }
    let shift = 0;
    if (toolbar && !toolbar.dataset.moved && toolbar.offsetParent !== null) {
      const [left, top, width, height] = (toolbar.dataset.dockNormal ?? "").split(",").map(Number);
      if (left === undefined || top === undefined || width === undefined || height === undefined || ![left, top, width, height].every(Number.isFinite)) return;
      const bar = { left: hostBox.left + left, top: hostBox.top + top, right: hostBox.left + left + width, bottom: hostBox.top + top + height };
      const range = document.createRange();
      const rows = [...this.root.children].flatMap((child) => getComputedStyle(child).flexDirection === "column" ? [...child.children] : [child]);
      if (rows.some((row) => {
        range.selectNodeContents(row);
        const text = range.getBoundingClientRect();
        return text.width > 0 && text.top < bar.bottom && text.right + 8 > bar.left;
      })) shift = height;
    }
    set("--legend-shift", `${shift}px`);
    const bounds = this.contentBounds();
    const paneBottom = chartBox.top + viewport.pricePane.top + viewport.pricePane.height;
    if (bounds.bottom > paneBottom + 0.5) {
      this.host.dataset.legendDensity = "compact";
      set("--legend-shift", "0px");
      const compact = this.contentBounds();
      const left = compact.right - hostBox.left + 8;
      set("--legend-dock-left", `${left}px`);
      set("--legend-dock-width", `${Math.max(0, chartBox.right - hostBox.left - viewport.axisWidth - 8 - left)}px`);
    }
    if (toolbar) toolbar.scrollLeft = scroll;
    this.finalGeometry = this.geometrySnapshot();
  }

  dispose(): void {
    this.disposed = true;
    document.fonts.removeEventListener("loadingdone", this.fontsChanged);
    if (this.presentationFrame !== null) cancelAnimationFrame(this.presentationFrame);
    this.presentationResize.disconnect();
    this.presentationMutations.disconnect();
    this.toolbarMutations.disconnect();
    delete this.host.dataset.legendDensity;
    for (const name of ["--legend-shift", "--legend-dock-left", "--legend-dock-width"]) this.host.style.removeProperty(name);
    this.root.remove();
  }
}
