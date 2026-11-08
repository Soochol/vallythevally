import type { Bar } from "../api/generated/Bar";
import type { Period } from "../api/generated/Period";
import { direction, formatChange, formatPercent, formatPrice, formatVolume } from "../lib/format";
import { formatBarTime } from "./time";

const ROW = "w-max pr-1 rounded-s bg-[color-mix(in_srgb,var(--chart-bg)_78%,transparent)]";
const DIR_CLASS = { up: "text-up", down: "text-down", flat: "text-text-2" } as const;

export interface LegendBar {
  bar: Bar;
  prev: Bar | null;
  /** 진행 중 구간(BarsPage.current)의 봉이면 `조회 값`을 붙인다. */
  isCurrent: boolean;
  isIndex: boolean;
  period: Period;
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
  readonly root = el("div", "pointer-events-none absolute left-2 top-1 z-[4] flex max-w-[calc(100%-90px)] flex-col gap-px");
  private readonly name = el("span", "text-m font-[650]");
  private readonly sub = el("span", "text-s text-text-3");
  private readonly period = el("span", "text-s text-text-3");
  private readonly priceRow = el("div", `${ROW} flex items-baseline gap-2 whitespace-nowrap max-md:hidden`);
  private readonly close = el("span", "text-xl font-semibold tracking-[-0.02em]");
  private readonly change = el("span", "text-s");
  private readonly time = el("span", "text-xs text-text-2");
  private readonly fetched = el(
    "span",
    "self-center rounded-[9px] border border-line px-1.5 text-xs text-text-3",
    "조회 값",
  );
  private readonly ohlc = el("div", `${ROW} flex flex-wrap gap-x-2 whitespace-nowrap text-s max-md:w-auto max-md:gap-x-1.5`);

  constructor(parent: HTMLElement) {
    const head = el("div", `${ROW} flex items-baseline gap-1.5 whitespace-nowrap max-md:hidden`);
    head.append(this.name, this.sub, this.period);
    this.fetched.title = "키움에서 조회한 값입니다. 체결마다 바뀌지 않습니다.";
    this.priceRow.append(this.close, this.change, this.time, this.fetched);
    this.root.append(head, this.priceRow, this.ohlc);
    parent.append(this.root);
  }

  setHead(name: string, sub: string, periodLabel: string): void {
    this.name.textContent = name;
    this.sub.textContent = sub;
    this.period.textContent = periodLabel;
  }

  show(v: LegendBar | null): void {
    this.priceRow.hidden = v === null;
    this.ohlc.hidden = v === null;
    if (!v) return;
    const { bar, prev, isIndex } = v;
    const chg = prev ? bar.c - prev.c : 0;
    const dir = DIR_CLASS[direction(chg)];
    this.close.textContent = formatPrice(bar.c, isIndex);
    this.close.className = `text-xl font-semibold tracking-[-0.02em] ${dir}`;
    this.change.textContent = prev ? `${formatChange(chg, isIndex)}  ${formatPercent((chg / prev.c) * 100)}` : "";
    this.change.className = `text-s whitespace-pre ${dir}`;
    this.time.textContent = formatBarTime(bar.t, v.period);
    this.fetched.hidden = !v.isCurrent;
    const cells: [string, string][] = [
      ["시", formatPrice(bar.o, isIndex)],
      ["고", formatPrice(bar.h, isIndex)],
      ["저", formatPrice(bar.l, isIndex)],
      ["종", formatPrice(bar.c, isIndex)],
      ["량", formatVolume(bar.v)],
    ];
    this.ohlc.replaceChildren(
      ...cells.map(([k, val]) => {
        const span = el("span", "");
        span.append(el("i", "mr-[3px] not-italic text-text-3", k), val);
        return span;
      }),
    );
  }

  dispose(): void {
    this.root.remove();
  }
}
