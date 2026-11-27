import { useSyncExternalStore, type ReactNode } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { NXT_UNAVAILABLE } from "../../lib/venue";
import { useVenue } from "../../stores/ui";
import { formatQuantity } from "./format";
import { ratioSplit } from "./ladder";
import type { WindowId, WindowKind } from "../../layout/kinds";
import { useLinkedSymbol } from "./MarketWindowGate";
import { useShownVenue } from "./useShownVenue";

export type TotalRatioMode = "percent" | "multiple";

const RATIO_MODE_KEY = "vally:total-ratio-mode";
const ratioListeners = new Set<() => void>();

function readRatioMode(): TotalRatioMode {
  try {
    return window.localStorage.getItem(RATIO_MODE_KEY) === "multiple" ? "multiple" : "percent";
  } catch {
    return "percent";
  }
}

let currentRatioMode: TotalRatioMode = typeof window === "undefined" ? "percent" : readRatioMode();

function subscribeRatioMode(listener: () => void): () => void {
  ratioListeners.add(listener);
  return () => ratioListeners.delete(listener);
}

function toggleRatioMode(): void {
  currentRatioMode = currentRatioMode === "percent" ? "multiple" : "percent";
  try {
    window.localStorage.setItem(RATIO_MODE_KEY, currentRatioMode);
  } catch {
  }
  ratioListeners.forEach((listener) => listener());
}

export function useTotalRatioMode(): readonly [TotalRatioMode, () => void] {
  const mode = useSyncExternalStore<TotalRatioMode>(subscribeRatioMode, () => currentRatioMode, () => "percent");
  return [mode, toggleRatioMode] as const;
}

export function formatTotalRatio(ask: number | null, bid: number | null, mode: TotalRatioMode): string {
  if (ask === null || bid === null) return "-";
  if (mode === "multiple") {
    if (bid <= 0) return ask > 0 ? "∞ : 1" : "-";
    return `${(ask / bid).toFixed(2)} : 1`;
  }
  const total = ask + bid;
  if (!(total > 0)) return "-";
  const askPct = Math.round((ask / total) * 100);
  return `${askPct}% : ${100 - askPct}%`;
}

export function FooterRatioBar({ ask, bid }: { ask: number | null; bid: number | null }) {
  const total = (ask ?? 0) + (bid ?? 0);
  const split = ask !== null && bid !== null && total > 0 ? ratioSplit(bid, ask) : { buy: 50, sell: 50 };
  return (
    <div className="mw-strip-ratio" aria-hidden="true">
      <i className="mw-strip-ratio-ask" style={{ width: `${split.sell}%` }} />
      <i className="mw-strip-ratio-bid" style={{ width: `${split.buy}%` }} />
    </div>
  );
}

export function TotalRatioToggle({ ask, bid }: { ask: number | null; bid: number | null }) {
  const [mode, toggle] = useTotalRatioMode();
  const text = formatTotalRatio(ask, bid, mode);
  const title = mode === "percent" ? "매도/매수 잔량 비율 (%) · 클릭해 배율(매수=1)로 전환" : "매도/매수 잔량 배율 (매수=1) · 클릭해 비율(%)로 전환";
  return (
    <button type="button" className="mw-strip-ratio-btn" data-testid="footer-ratio-toggle" data-mode={mode} title={title} aria-label={title} onClick={toggle}>
      {text}
    </button>
  );
}

interface LadderFooterProps {
  readonly ask: number | null;
  readonly bid: number | null;
  readonly left: ReactNode;
  readonly right: ReactNode;
  readonly className?: string;
  readonly testId?: string;
}

export function LadderFooter({ ask, bid, left, right, className, testId }: LadderFooterProps) {
  return (
    <div className={className ? `mw-footer ${className}` : "mw-footer"} data-testid={testId}>
      <FooterRatioBar ask={ask} bid={bid} />
      <div className="mw-footer-side">{left}</div>
      <TotalRatioToggle ask={ask} bid={bid} />
      <div className="mw-footer-side">{right}</div>
    </div>
  );
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

import { Segmented as UiSegmented } from "../ui/Segmented";

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export function Segmented<T extends string>({ label, options, value, disabled, onChange }: { label: string; options: readonly SegmentOption<T>[]; value: T; disabled?: readonly T[]; onChange(value: T): void }) {
  return (
    <UiSegmented
      label={label}
      mode="pressed"
      size="sm"
      value={value}
      options={options.map((option) => ({ ...option, disabled: disabled?.includes(option.value) }))}
      onChange={onChange}
    />
  );
}

const FOLLOWING_KINDS: readonly WindowKind[] = ["book", "order"];

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
  return FOLLOWING_KINDS.includes(kind) ? <FollowingBadge id={id} /> : null;
}
