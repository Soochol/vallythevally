import { describe, expect, it } from "vitest";
import { barInterval } from "../../chart/crosshairSync";
import { gapContaining, resolveBrokerSyncTarget } from "./chartSync";

const kstSec = (iso: string) => Date.parse(`${iso}+09:00`) / 1000;
const kstMs = (iso: string) => Date.parse(`${iso}+09:00`);

describe("거래원 차트 동기화 대상 해석", () => {
  const nowMs = kstMs("2026-11-09T10:32:30");

  it("동기화가 꺼져 있으면 off, 가리킨 봉이 없거나 종목이 다르면 waiting이다", () => {
    const pointer = { symbol: "005930", bar: barInterval(kstSec("2026-11-06T09:15:00"), "5m"), close: 70_400 };
    expect(resolveBrokerSyncTarget(false, "005930", pointer, nowMs)).toEqual({ kind: "off" });
    expect(resolveBrokerSyncTarget(true, "005930", null, nowMs)).toEqual({ kind: "waiting" });
    expect(resolveBrokerSyncTarget(true, "000660", pointer, nowMs)).toEqual({ kind: "waiting" });
  });

  it("분봉은 봉 마감 시각으로 맞추고 진행 중인 현재 봉은 최신 시각으로 둔다", () => {
    const closed = { symbol: "005930", bar: barInterval(kstSec("2026-11-06T10:15:00"), "5m"), close: 70_800 };
    expect(resolveBrokerSyncTarget(true, "005930", closed, nowMs)).toEqual({
      kind: "synced",
      date: "20261106",
      isToday: false,
      cursor: kstSec("2026-11-06T10:19:59"),
      period: "5m",
      close: 70_800,
    });

    const inProgress = { symbol: "005930", bar: barInterval(kstSec("2026-11-09T10:30:00"), "5m"), close: 71_400 };
    expect(resolveBrokerSyncTarget(true, "005930", inProgress, nowMs)).toEqual({
      kind: "synced",
      date: "20261109",
      isToday: true,
      cursor: null,
      period: "5m",
      close: 71_400,
    });
  });

  it("일봉은 그날 전체로 맞추고 주봉 이상은 미지원으로 알린다", () => {
    const daily = { symbol: "005930", bar: barInterval(kstSec("2026-11-06T00:00:00"), "D"), close: 70_700 };
    expect(resolveBrokerSyncTarget(true, "005930", daily, nowMs)).toEqual({
      kind: "synced",
      date: "20261106",
      isToday: false,
      cursor: null,
      period: "D",
      close: 70_700,
    });

    const weekly = { symbol: "005930", bar: barInterval(kstSec("2026-11-02T00:00:00"), "W"), close: 70_700 };
    expect(resolveBrokerSyncTarget(true, "005930", weekly, nowMs)).toEqual({
      kind: "unsupported",
      period: "W",
    });
  });

  it("끊긴 구간 안에 있는 시각을 찾는다", () => {
    const gaps: readonly (readonly [number, number])[] = [[100, 200], [400, 500]];
    expect(gapContaining(gaps, null)).toBeNull();
    expect(gapContaining(gaps, 99)).toBeNull();
    expect(gapContaining(gaps, 100)).toEqual([100, 200]);
    expect(gapContaining(gaps, 150)).toEqual([100, 200]);
    expect(gapContaining(gaps, 201)).toBeNull();
  });
});
