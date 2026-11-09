import { expect, test } from "vitest";
import { calendarTime, parseCalendarTime, parseSeconds } from "./timeInput";

test("calendar conversion safely refuses server-valid seconds outside calendar inputs", () => {
  for (const t of [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 8_640_000_000_000]) expect(calendarTime(t)).toBeNull();
  expect(calendarTime(0)).toBe("1970-01-01T09:00:00");
  expect(parseCalendarTime("2026-11-10T09:00:00")).toBe(1794268800);
  expect(parseCalendarTime("2026-11-10T09:00")).toBe(1794268800);
});

test("calendar edits reject invalid dates and fractional seconds rather than rounding them", () => {
  for (const value of ["", "not-a-date", "2026-02-30T09:00", "2026-11-10T09:00:00.5", "0000-01-01T00:00:00"]) expect(parseCalendarTime(value)).toBeNull();
});

test("numeric timestamp fallback preserves the full safe-integer seconds contract", () => {
  for (const t of [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0, -1]) expect(parseSeconds(String(t))).toBe(t);
  for (const value of ["", " ", "1.5", "1e3", "9007199254740992"]) expect(parseSeconds(value)).toBeNull();
});
