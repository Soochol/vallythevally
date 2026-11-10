const KST_SECONDS = 9 * 3600;

export function calendarTime(t: number): string | null {
  const date = new Date((t + KST_SECONDS) * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getUTCFullYear();
  return year >= 1 && year <= 9999 ? date.toISOString().slice(0, 19) : null;
}

export function parseCalendarTime(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const t = Date.parse(`${value}+09:00`) / 1000;
  const canonical = value.length === 16 ? `${value}:00` : value;
  return Number.isSafeInteger(t) && calendarTime(t) === canonical ? t : null;
}

export function parseSeconds(value: string): number | null {
  if (!/^-?\d+$/.test(value)) return null;
  const t = Number(value);
  return Number.isSafeInteger(t) ? t : null;
}
