import { beforeEach, expect, test } from "vitest";
import { barInterval } from "../chart/crosshairSync";
import { useBookReplayStore } from "./bookReplay";

const NINE = Date.UTC(2026, 10, 23, 0, 0, 0) / 1000;
const store = () => useBookReplayStore.getState();

beforeEach(() => store().clear());

test("일봉은 가리켜도 기억하지 않고 같은 봉을 다시 가리키면 상태가 바뀌지 않는다", () => {
  const changes: unknown[] = [];
  const stop = useBookReplayStore.subscribe((state) => changes.push(state.pointed));
  store().point("005930", barInterval(NINE, "5m"));
  const first = store().pointed;
  expect(first).toEqual({ symbol: "005930", bar: barInterval(NINE, "5m") });

  store().point("005930", barInterval(NINE, "5m"));
  store().point("005930", null);
  store().point("000660", null);
  expect(store().pointed).toBe(first);
  expect(changes).toHaveLength(1);

  store().point("005930", barInterval(NINE, "1m"));
  expect(store().pointed?.bar.period).toBe("1m");
  store().point("000660", barInterval(NINE, "5m"));
  expect(store().pointed?.symbol).toBe("000660");
  store().point("000660", barInterval(NINE, "D"));
  expect(store().pointed).toBeNull();
  expect(changes).toHaveLength(4);

  store().point("005930", barInterval(NINE, "60m"));
  store().clear();
  expect(store().pointed).toBeNull();
  stop();
});
