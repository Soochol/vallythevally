import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { ViDirection } from "../../api/generated/ViDirection";
import { useSymbolVi } from "../../stores/symbolVi";

const TONE: Record<ViDirection, string> = {
  up: "text-up",
  down: "text-down",
};

const ACCESSIBLE_TEXT: Record<ViDirection, string> = {
  up: "상승 VI",
  down: "하락 VI",
};

interface WatchViBadgeProps {
  id: string;
  code: SymbolCode;
}

export function WatchViBadge({ id, code }: WatchViBadgeProps) {
  const state = useSymbolVi(code);
  if (!state?.active) return null;
  const tone = state.direction === null ? "text-text-2" : TONE[state.direction];
  const accessibleText = state.direction === null ? "VI" : ACCESSIBLE_TEXT[state.direction];
  return (
    <span
      id={id}
      data-testid="watch-vi"
      className={`inline-flex h-[16px] shrink-0 items-center justify-center whitespace-nowrap rounded-s border border-current px-[3px] text-xs font-[600] leading-none ${tone}`}
    >
      <span aria-hidden="true">VI</span>
      <span className="sr-only">{accessibleText}</span>
    </span>
  );
}
