import { Select } from "../menu/Select";
import { VENUE_LABEL, VENUES } from "../../lib/venue";
import { useUiStore, useVenue } from "../../stores/ui";

const PHONE_PILL =
  "h-7 min-w-10 rounded-[var(--r-pill)] px-2 text-s text-text-2 aria-pressed:bg-accent aria-pressed:font-[650] aria-pressed:text-accent-ink";

const VENUE_HINT = { combined: "KRX와 NXT를 합친 시세", krx: "한국거래소 정규장 시세", nxt: "넥스트레이드 시세 · 없는 종목은 통합" } as const;
const VENUE_MENU_HEADING = "거래소 · 모든 차트와 관심종목에 적용";
const VENUE_OPTIONS = VENUES.map((value) => ({ value, label: VENUE_LABEL[value], hint: VENUE_HINT[value], group: VENUE_MENU_HEADING }));

/** 앱 전체 거래소 고르기: 통합 / KRX / NXT(ADR 0020). 데스크톱은 콤보박스, 휴대폰은 알약 묶음. */
export function VenuePicker({ variant }: { variant: "desktop" | "phone" }) {
  const venue = useVenue();
  const setVenue = useUiStore((s) => s.setVenue);

  if (variant === "desktop") {
    return (
      <div className="venue-picker">
        <span aria-hidden className="venue-picker-prefix">거래소</span>
        <Select label="거래소" value={venue} options={VENUE_OPTIONS} onChange={setVenue} className="venue-picker-select" />
      </div>
    );
  }
  return (
    <div role="group" aria-label="거래소" className="inline-flex flex-none gap-px rounded-[var(--r-pill)] bg-[var(--hover)] p-0.5">
      {VENUES.map((v) => (
        <button key={v} type="button" className={PHONE_PILL} aria-pressed={venue === v} title={`${VENUE_LABEL[v]} 시세`} onClick={() => setVenue(v)}>
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
