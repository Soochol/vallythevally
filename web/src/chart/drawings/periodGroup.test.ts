import { expect, test } from "vitest";
import { periodGroup } from "./periodGroup";

const MINUTES = ["1m", "3m", "5m", "10m", "15m", "30m", "60m"];
const DAILY_AND_UP = ["D", "W", "M", "Q", "Y"];

test("every minute period maps to the minute group", () => {
  for (const p of MINUTES) expect(periodGroup(p as never)).toEqual(MINUTES);
});

test("every period from daily up maps to the daily-and-up group", () => {
  for (const p of DAILY_AND_UP) expect(periodGroup(p as never)).toEqual(DAILY_AND_UP);
});
