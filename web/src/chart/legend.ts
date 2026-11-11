import type { Bar } from "../api/generated/Bar";
import type { Period } from "../api/generated/Period";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import { type Direction, direction, formatChange, formatPercent, formatPrice, formatVolume } from "../lib/format";
import { formatBarTime, formatKstClock } from "./time";

const ROW = "w-max pr-1 rounded-s bg-[color-mix(in_srgb,var(--chart-bg)_78%,transparent)]";
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

export interface LegendParts {
  close: string;
  change: string;
  dir: Direction;
  time: string;
  cells: [label: string, value: string][];
}

export function legendParts({ bar, prev, isIndex, period }: LegendBar): LegendParts {
  const chg = prev ? bar.c - prev.c : 0;
  return {
    close: formatPrice(bar.c, isIndex),
    change: prev ? `${formatChange(chg, isIndex)}  ${formatPercent((chg / prev.c) * 100)}` : "",
    dir: direction(chg),
    time: formatBarTime(bar.t, period),
    cells: [
      ["시", formatPrice(bar.o, isIndex)],
      ["고", formatPrice(bar.h, isIndex)],
      ["저", formatPrice(bar.l, isIndex)],
      ["종", formatPrice(bar.c, isIndex)],
      ["량", formatVolume(bar.v)],
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
  readonly root = el("div", "pointer-events-none absolute left-5 top-4 z-[4] flex max-w-[calc(100%-90px)] flex-col gap-2");
  private readonly name = el("span", "text-l font-[650]");
  private readonly sub = el("span", "text-s text-text-3");
  private readonly venue = el("span", "text-s text-text-2");
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
  private readonly stalled = el("span", "self-center rounded-[9px] border border-accent px-1.5 text-xs text-accent");
  private readonly notice = el("span", "text-xs text-accent");
  private readonly ohlc = el("div", `${ROW} flex flex-wrap gap-x-2 whitespace-nowrap text-s max-md:w-auto max-md:gap-x-1.5`);

  constructor(parent: HTMLElement) {
    const head = el("div", `${ROW} flex items-baseline gap-1.5 whitespace-nowrap max-md:hidden`);
    head.append(this.name, this.sub, this.venue, this.period, this.notice);
    this.notice.hidden = true;
    this.fetched.title = "키움에서 조회한 값입니다. 체결마다 바뀌지 않습니다.";
    this.stalled.title = "실시간 시세가 멈췄습니다. 마지막으로 받은 값입니다.";
    this.priceRow.append(this.close, this.change, this.time, this.fetched, this.stalled);
    this.root.append(head, this.priceRow, this.ohlc);
    parent.append(this.root);
  }

  setHead(h: { name: string; sub: string; venue: string; period: string }): void {
    this.name.textContent = h.name;
    this.sub.textContent = h.sub;
    this.venue.textContent = h.venue;
    this.venue.hidden = h.venue === "";
    this.period.textContent = h.period;
  }

  /** 머리줄 끝의 짧은 안내(구독 오류). null이면 숨긴다. */
  setNotice(text: string | null): void {
    this.notice.textContent = text ?? "";
    this.notice.hidden = text === null;
  }

  show(v: LegendBar | null): void {
    this.priceRow.hidden = v === null;
    this.ohlc.hidden = v === null;
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
    this.ohlc.replaceChildren(
      ...parts.cells.map(([k, val]) => {
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
