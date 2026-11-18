import type { ReactNode } from "react";
import { useVenue } from "../../stores/ui";
import { formatShares } from "./format";
import { ratioSplit } from "./ladder";
import type { WindowKind } from "../../layout/kinds";

export function Strip({ children, divided }: { children: ReactNode; divided?: boolean }) {
  return <div className="mw-strip" data-divided={divided ? "" : undefined}>{children}</div>;
}

export function RatioBar({ buy, sell, sellFirst, label }: { buy: number; sell: number; sellFirst?: boolean; label: string }) {
  const split = ratioSplit(buy, sell);
  const sellPart = <i key="sell" className="mw-ratio-sell" style={{ width: `${split.sell}%` }} />;
  const buyPart = <i key="buy" className="mw-ratio-buy" style={{ width: `${split.buy}%` }} />;
  return <div className="mw-ratio" role="img" aria-label={label} title={label}>{sellFirst ? [sellPart, buyPart] : [buyPart, sellPart]}</div>;
}

export function TotalFigure({ testId, tone, value, afterHours, description }: { testId: string; tone: "up" | "down"; value: number | null; afterHours: boolean; description: string | null }) {
  return (
    <b data-testid={testId} className={tone === "up" ? "mw-up" : "mw-down"} data-source={afterHours ? "after-hours" : "regular"} title={description ?? undefined}>
      {afterHours && <small className="mw-total-tag">시간외</small>}
      {value === null ? "-" : formatShares(value)}
    </b>
  );
}

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export function Segmented<T extends string>({ label, options, value, disabled, onChange }: { label: string; options: readonly SegmentOption<T>[]; value: T; disabled?: readonly T[]; onChange(value: T): void }) {
  return (
    <div className="mw-seg" role="group" aria-label={label}>
      {options.map((option) => <button key={option.value} type="button" aria-pressed={option.value === value} disabled={disabled?.includes(option.value)} onClick={() => onChange(option.value)}>{option.label}</button>)}
    </div>
  );
}

const INTEGRATED_KINDS: readonly WindowKind[] = ["book", "program", "brokers", "order"];

export const showsIntegratedBadge = (kind: WindowKind): boolean => INTEGRATED_KINDS.includes(kind);

export function IntegratedBadge() {
  const venue = useVenue();
  if (venue === "combined") return null;
  return <span className="mw-integrated" title="키움 호가·프로그램·거래원은 KRX와 NXT를 합친 값입니다">통합</span>;
}
