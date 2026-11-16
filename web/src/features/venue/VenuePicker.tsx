import { VENUE_LABEL, VENUES } from "../../lib/venue";
import { useUiStore, useVenue } from "../../stores/ui";

const CLASS = {
  desktop: "seg-btn",
  phone:
    "h-7 min-w-10 rounded-[var(--r-pill)] px-2 text-s text-text-2 aria-pressed:bg-accent aria-pressed:font-[650] aria-pressed:text-accent-ink",
} as const;

/** 앱 전체 거래소 고르기: 통합 / KRX / NXT(ADR 0020). */
export function VenuePicker({ variant }: { variant: keyof typeof CLASS }) {
  const venue = useVenue();
  const setVenue = useUiStore((s) => s.setVenue);

  return (
    <div
      role="group"
      aria-label="거래소"
      className={variant === "desktop" ? "venue-picker inline-flex flex-none items-center gap-px" : "inline-flex flex-none gap-px rounded-[var(--r-pill)] bg-[var(--hover)] p-0.5"}
    >
      {VENUES.map((v) => (
        <button key={v} type="button" className={CLASS[variant]} aria-pressed={venue === v} title={`${VENUE_LABEL[v]} 시세`} onClick={() => setVenue(v)}>
          {VENUE_LABEL[v]}
        </button>
      ))}
    </div>
  );
}

export const NXT_FALLBACK_TITLE = "NXT에서 거래되지 않는 종목이라 통합 시세로 보입니다";

/** 앱 전체 거래소와 다른 거래소로 보이는 칸의 읽기 전용 표시. */
export function VenueFallbackBadge() {
  return (
    <span className="pointer-events-auto inline-flex h-6 flex-none items-center rounded-s px-1.5 text-xs text-text-3" title={NXT_FALLBACK_TITLE}>
      통합
    </span>
  );
}
