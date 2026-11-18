import type { IRange, ITimeScaleApi, Time } from "lightweight-charts";
import type { Bar } from "../api/generated/Bar";
import type { Period } from "../api/generated/Period";
import { toChartTime } from "./time";

export const RIGHT_OFFSET = 6;
const SAME_RANGE = 0.001;
const DESKTOP_BARS = 130;
const NARROW_BARS = 90;

export type RangeScale = Pick<ITimeScaleApi<Time>, "timeToIndex" | "setVisibleLogicalRange" | "applyOptions">;

export interface HostSize {
  width: number;
  height: number;
}

export interface FitInput {
  bars: readonly Bar[];
  period: Period;
  visibleBars: number | null;
  narrow: boolean;
  rightOffset?: number;
}

export function initialRangeOf(input: FitInput, startIndex: number, endIndex: number): IRange<number> {
  const whole = input.visibleBars === null && (input.period === "Y" || input.period === "Q");
  const show = input.visibleBars ?? (input.narrow ? NARROW_BARS : DESKTOP_BARS);
  return whole
    ? { from: startIndex - 0.5, to: endIndex + 0.5 + Math.min(2, input.bars.length * 0.05) }
    : { from: endIndex + 1 - show, to: endIndex + (input.rightOffset ?? RIGHT_OFFSET) };
}

export class InitialRange {
  private fitted: { range: IRange<number>; host: HostSize } | null = null;

  constructor(private readonly scale: () => RangeScale, private readonly host: () => HostSize) {}

  get held(): boolean {
    return this.fitted !== null;
  }

  fit(input: FitInput): void {
    const first = input.bars[0];
    const last = input.bars.at(-1);
    if (!first || !last) return;
    const scale = this.scale();
    const start = scale.timeToIndex(toChartTime(first.t), false);
    const end = scale.timeToIndex(toChartTime(last.t), false);
    if (start === null || end === null) return;
    const range = initialRangeOf(input, start, end);
    this.fitted = null;
    scale.applyOptions({ lockVisibleTimeRangeOnResize: true });
    scale.setVisibleLogicalRange(range);
    this.fitted = { range, host: this.host() };
  }

  release(): void {
    if (!this.fitted) return;
    this.fitted = null;
    this.scale().applyOptions({ lockVisibleTimeRangeOnResize: false });
  }

  hostResized(): void {
    const host = this.host();
    if (this.fitted && (this.fitted.host.width !== host.width || this.fitted.host.height !== host.height)) this.release();
  }

  rangeChanged(range: IRange<number> | null): void {
    const fitted = this.fitted?.range;
    if (range && fitted && (Math.abs(range.from - fitted.from) >= SAME_RANGE || Math.abs(range.to - fitted.to) >= SAME_RANGE)) this.release();
  }

  forget(): void {
    this.fitted = null;
  }
}
