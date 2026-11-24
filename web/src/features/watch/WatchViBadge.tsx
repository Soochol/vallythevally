import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { ViDirection } from "../../api/generated/ViDirection";
import type { ViMarket } from "../../api/generated/ViMarket";
import { useSymbolVi } from "../../stores/symbolVi";

const TONE: Record<ViDirection, string> = {
  up: "text-up",
  down: "text-down",
};

const LABEL: Record<ViMarket, string> = {
  krx: "KVI",
  nxt: "NVI",
};

const DIRECTION_LABEL: Record<ViDirection, string> = {
  up: "상승",
  down: "하락",
};

interface WatchViBadgeProps {
  id: string;
  code: SymbolCode;
  market: ViMarket;
}

export function WatchViBadge({ id, code, market }: WatchViBadgeProps) {
  const state = useSymbolVi(code, market);
  if (!state?.active) return null;
  const label = LABEL[market];
  const tone = state.direction === null ? "text-text-2" : TONE[state.direction];
  const accessibleText = state.direction === null ? label : `${DIRECTION_LABEL[state.direction]} ${label}`;
  return (
    <span
      id={id}
      data-testid="watch-vi"
      data-market={market}
      className={`inline-flex h-[16px] shrink-0 items-center justify-center whitespace-nowrap rounded-s border border-current px-[3px] text-xs font-[600] leading-none ${tone}`}
    >
      <span aria-hidden="true">{label}</span>
      <span className="sr-only">{accessibleText}</span>
    </span>
  );
}
