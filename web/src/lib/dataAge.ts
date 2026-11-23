export const DATA_CADENCE_SECONDS = {
  ranking: 10,
  heatmapBoard: 30,
  heatmapFlow: 60,
  marketOverview: 60,
  screener: 30,
} as const;

export type DataCadence = keyof typeof DATA_CADENCE_SECONDS;

export const AGE_SHOWN_AFTER_CADENCES = 2;
export const STALE_LIVE_AFTER_SECONDS = 300;

export interface DataAge {
  label: string | null;
  stale: boolean;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function ageLabel(ageSeconds: number): string {
  if (ageSeconds < MINUTE) return `${Math.floor(ageSeconds)}초 전 자료`;
  if (ageSeconds < HOUR) return `${Math.floor(ageSeconds / MINUTE)}분 전 자료`;
  if (ageSeconds < DAY) return `${Math.floor(ageSeconds / HOUR)}시간 전 자료`;
  return `${Math.floor(ageSeconds / DAY)}일 전 자료`;
}

export function assessDataAge(recordedAt: number | null, nowSeconds: number, cadence: DataCadence, live: boolean): DataAge {
  if (recordedAt === null) return { label: null, stale: false };
  const age = Math.max(0, nowSeconds - recordedAt);
  return {
    label: age > DATA_CADENCE_SECONDS[cadence] * AGE_SHOWN_AFTER_CADENCES ? ageLabel(age) : null,
    stale: live && age > STALE_LIVE_AFTER_SECONDS,
  };
}
