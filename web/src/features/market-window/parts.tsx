import type { ReactNode } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { NXT_UNAVAILABLE } from "../../lib/venue";
import { useVenue } from "../../stores/ui";
import { formatQuantity } from "./format";
import { ratioSplit } from "./ladder";
import type { WindowId, WindowKind } from "../../layout/kinds";
import { useLinkedSymbol } from "./MarketWindowGate";
import { useShownVenue } from "./useShownVenue";

export function Strip({ children, divided }: { children: ReactNode; divided?: boolean }) {
  return <div className="mw-strip" data-divided={divided ? "" : undefined}>{children}</div>;
}

export function RatioBar({ buy, sell, sellFirst, label }: { buy: number; sell: number; sellFirst?: boolean; label: string }) {
  const split = ratioSplit(buy, sell);
  const sellPart = <i key="sell" className="mw-ratio-sell" style={{ transform: `scaleX(${split.sell / 100})` }} />;
  const buyPart = <i key="buy" className="mw-ratio-buy" style={{ transform: `scaleX(${split.buy / 100})` }} />;
  return <div className="mw-ratio" role="img" aria-label={label} title={label}>{sellFirst ? [sellPart, buyPart] : [buyPart, sellPart]}</div>;
}

export function TotalFigure({ testId, tone, value, afterHours, description, hideAfterHoursTag }: { testId: string; tone: "up" | "down"; value: number | null; afterHours: boolean; description: string | null; hideAfterHoursTag?: boolean }) {
  return (
    <b data-testid={testId} className={tone === "up" ? "mw-up" : "mw-down"} data-source={afterHours ? "after-hours" : "regular"} title={description ?? undefined}>
      {afterHours && !hideAfterHoursTag && <small className="mw-total-tag">시간외</small>}
      {value === null ? "-" : formatQuantity(value)}
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

const COMBINED_ONLY_KINDS: readonly WindowKind[] = ["program", "brokers"];
const FOLLOWING_KINDS: readonly WindowKind[] = ["book", "order"];

function CombinedOnlyBadge() {
  if (useVenue() === "combined") return null;
  return <span className="mw-integrated" title="키움 프로그램·거래원은 KRX와 NXT를 합친 값입니다">통합</span>;
}

function SubstitutedBadge({ code }: { code: SymbolCode }) {
  const appVenue = useVenue();
  const shown = useShownVenue(code);
  if (shown === appVenue) return null;
  return <span className="mw-integrated" title={`${NXT_UNAVAILABLE}이라 통합 시세를 보입니다`}>통합</span>;
}

function FollowingBadge({ id }: { id: WindowId }) {
  const code = useLinkedSymbol(id);
  return code === null ? null : <SubstitutedBadge code={code} />;
}

export function IntegratedBadge({ id, kind }: { id: WindowId; kind: WindowKind }) {
  if (COMBINED_ONLY_KINDS.includes(kind)) return <CombinedOnlyBadge />;
  return FOLLOWING_KINDS.includes(kind) ? <FollowingBadge id={id} /> : null;
}
