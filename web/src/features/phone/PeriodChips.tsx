import type { Period } from "../../api/generated/Period";
import { PERIOD_LABEL } from "../../lib/symbol";
import { type CellState, useLayoutStore } from "../../stores/layout";

const CHIPS = ["5m", "15m", "60m", "D", "W", "M"] as const satisfies readonly Period[];

/** 휴대폰 봉 주기 칩(frontend.md §4). */
export function PeriodChips({ cell }: { cell: CellState }) {
  const setPeriod = useLayoutStore((s) => s.setPeriod);
  return (
    <nav
      aria-label="봉 주기"
      className="hidden gap-1 overflow-x-auto border-b border-line px-3 pb-2 [grid-area:mper] [scrollbar-width:none] max-md:flex"
    >
      {CHIPS.map((p) => (
        <button
          key={p}
          type="button"
          aria-pressed={cell.period === p}
          onClick={() => setPeriod(cell.slot, p)}
          className="h-[36px] min-w-[44px] flex-none rounded-full border border-line px-3 text-text-2 aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:font-[650] aria-pressed:text-accent-ink"
        >
          {PERIOD_LABEL[p]}
        </button>
      ))}
    </nav>
  );
}
