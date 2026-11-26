// @vitest-environment happy-dom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useServerClock } from "../../stores/serverClock";
import { resetDomAfterEach } from "../../test/domSetup";
import { DataAgeNote, STALE_NOTE } from "./DataAgeNote";

beforeEach(() => {
  vi.useFakeTimers();
  useServerClock.setState({ serverTimeOrigin: null });
});

afterEach(() => {
  vi.useRealTimers();
});

resetDomAfterEach();

test("장중 기준 주기 2배 이하 숨김, 300초 전 정상 표기, 300초 초과 시 지연 경고를 표시한다", async () => {
  const nowMs = Date.parse("2026-11-18T10:10:00+09:00");
  vi.setSystemTime(nowMs);
  const nowSec = Math.floor(nowMs / 1000);

  const { rerender } = render(<DataAgeNote recordedAt={nowSec - 15} cadence="ranking" />);
  expect(screen.queryByTestId("data-age")).toBeNull();

  rerender(<DataAgeNote recordedAt={nowSec - 65} cadence="ranking" />);
  const fresh = screen.getByTestId("data-age");
  expect(fresh.textContent).toBe("1분 전 자료");
  expect(fresh.getAttribute("data-stale")).toBe("false");

  rerender(<DataAgeNote recordedAt={nowSec - 360} cadence="screener" />);
  const stale = screen.getByTestId("data-age");
  expect(stale.textContent).toBe(`6분 전 자료 · ${STALE_NOTE}`);
  expect(stale.getAttribute("data-stale")).toBe("true");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByTestId("data-age").getAttribute("data-stale")).toBe("true");
});

test("장 마감 후에는 오래된 자료도 지연 경고를 띄우지 않고 서버 시각 기준으로 갱신된다", () => {
  const afterCloseMs = Date.parse("2026-11-18T20:30:00+09:00");
  vi.setSystemTime(afterCloseMs);
  const closedSec = Math.floor(afterCloseMs / 1000);

  render(<DataAgeNote recordedAt={closedSec - 1800} cadence="marketOverview" />);
  const note = screen.getByTestId("data-age");
  expect(note.textContent).toBe("30분 전 자료");
  expect(note.textContent).not.toContain(STALE_NOTE);
  expect(note.getAttribute("data-stale")).toBe("false");
});
