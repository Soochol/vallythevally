import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { NXT_UNAVAILABLE, shownVenue, VENUE_LABEL, VENUES } from "../../lib/venue";
import { type CellState, useLayoutStore } from "../../stores/layout";

const LOOKING_UP = "종목 정보를 받는 중";

const CLASS = {
  desktop: "seg-btn",
  legend: "pointer-events-auto seg-btn !h-6 !min-w-0 !px-1.5 !text-xs",
  phone:
    "h-7 min-w-10 rounded-[var(--r-pill)] px-2 text-s text-text-2 aria-pressed:bg-accent aria-pressed:font-[650] aria-pressed:text-accent-ink aria-disabled:text-text-3 aria-disabled:opacity-60",
} as const;

/**
 * 칸의 거래소 고르기: 통합 / KRX / NXT(ADR 0007). 지수(venue null)면 그리지 않는다.
 * 고를 수 없는 NXT는 초점을 받아 이유를 읽을 수 있게 `disabled` 대신 `aria-disabled`로 둔다.
 */
export function VenuePicker({ cell, info, variant }: { cell: CellState; info: SymbolInfo | undefined; variant: keyof typeof CLASS }) {
  const setVenue = useLayoutStore((s) => s.setVenue);
  const current = shownVenue(cell.venue, info);
  if (current === null) return null;
  const nxtReason = info === undefined ? LOOKING_UP : info.nxtEnabled ? null : NXT_UNAVAILABLE;

  return (
    <div
      role="group"
      aria-label="거래소"
      className={
        variant !== "phone"
          ? "inline-flex items-center gap-px"
          : "inline-flex flex-none gap-px rounded-[var(--r-pill)] bg-[var(--hover)] p-0.5"
      }
    >
      {VENUES.map((v) => {
        const reason = v === "nxt" ? nxtReason : null;
        return (
          <button
            key={v}
            type="button"
            data-chart-control=""
            className={CLASS[variant]}
            aria-pressed={current === v}
            aria-disabled={reason !== null || undefined}
            aria-label={reason ? `${VENUE_LABEL[v]}, ${reason}` : undefined}
            title={reason ?? `${VENUE_LABEL[v]} 시세`}
            onClick={() => reason === null && setVenue(cell.slot, v)}
          >
            {VENUE_LABEL[v]}
          </button>
        );
      })}
    </div>
  );
}
