import { describe, expect, test } from "vitest";
import type { Bar } from "../api/generated/Bar";
import type { Period } from "../api/generated/Period";
import { windowId } from "../layout/kinds";
import { barAtRightEdge, jumpAnchor, jumpHeld, jumpNotice, jumpRoute, type JumpChart, jumpTargets, lastBarBefore } from "./barJump";
import { barInterval } from "./crosshairSync";

const kst = (text: string) => Date.parse(`${text}+09:00`) / 1000;
const bar = (t: number): Bar => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 });
const chart = (id: string, symbol: string, period: Period): JumpChart => ({ id: windowId(id), symbol, period });
const ids = (list: readonly { toString(): string }[]) => list.map(String);

describe("대상 고르기", () => {
  const charts = [chart("d", "005930", "D"), chart("m1", "005930", "1m"), chart("m5", "005930", "5m"), chart("other", "000660", "1m"), chart("d2", "005930", "D"), chart("w", "005930", "W")];

  test("일봉 → 같은 종목의 1분·5분만. 자신, 다른 종목, 같거나 긴 주기는 뺀다", () => {
    expect(ids(jumpTargets(charts, windowId("d"), "D"))).toEqual(["m1", "m5"]);
  });

  test("주봉 → 일봉", () => {
    expect(ids(jumpTargets(charts, windowId("w"), "W"))).toEqual(["d", "m1", "m5", "d2"]);
    expect(ids(jumpTargets([chart("w", "005930", "W"), chart("d", "005930", "D")], windowId("w"), "W"))).toEqual(["d"]);
  });

  test("60분 → 1분", () => {
    expect(ids(jumpTargets([chart("h", "005930", "60m"), chart("m1", "005930", "1m"), chart("h2", "005930", "60m")], windowId("h"), "60m"))).toEqual(["m1"]);
  });

  test("기준 창이 목록에 없으면 비었다", () => {
    expect(jumpTargets(charts, windowId("nope"), "D")).toEqual([]);
  });
});

describe("기준 봉", () => {
  const days = [kst("2026-11-05T00:00:00"), kst("2026-11-06T00:00:00"), kst("2026-11-09T00:00:00")].map(bar);

  test("화면 끝이 봉 사이면 그 이하의 마지막 봉", () => {
    expect(barAtRightEdge(days, kst("2026-11-07T12:00:00"))?.t).toBe(days[1]!.t);
    expect(barAtRightEdge(days, days[0]!.t)?.t).toBe(days[0]!.t);
  });

  test("오른쪽 여백이면 마지막 봉, 진행 중 봉도 포함", () => {
    expect(barAtRightEdge(days, kst("2026-12-31T00:00:00"))?.t).toBe(days[2]!.t);
    expect(barAtRightEdge(days, null)?.t).toBe(days[2]!.t);
  });

  test("봉이 없거나 모두 화면 끝보다 오른쪽이면 없음", () => {
    expect(barAtRightEdge([], 100)).toBeNull();
    expect(barAtRightEdge(days, days[0]!.t - 1)).toBeNull();
    expect(jumpAnchor(null, "D")).toBeNull();
  });

  test("메뉴 이름: 일봉은 날짜, 분봉은 날짜와 시각", () => {
    expect(jumpAnchor(bar(kst("2026-11-09T00:00:00")), "D")?.label).toBe("바로가기 · 2026-11-09");
    expect(jumpAnchor(bar(kst("2026-11-09T10:30:00")), "5m")?.label).toBe("바로가기 · 2026-11-09 10:30");
  });

  test("기준 날짜는 구간 마지막 순간의 한국 날짜다", () => {
    expect(jumpAnchor(bar(kst("2026-11-09T00:00:00")), "D")?.date).toBe("2026-11-09");
    expect(jumpAnchor(bar(kst("2026-11-09T10:30:00")), "5m")?.date).toBe("2026-11-09");
    expect(jumpAnchor(bar(kst("2026-11-09T00:00:00")), "W")?.date).toBe("2026-11-15");
    expect(jumpAnchor(bar(kst("2026-11-01T00:00:00")), "M")?.date).toBe("2026-11-30");
    expect(jumpAnchor(bar(kst("2026-11-09T00:00:00")), "D")?.interval).toEqual(barInterval(kst("2026-11-09T00:00:00"), "D"));
  });
});

describe("길 고르기", () => {
  const base = { today: "2026-11-19", held: false };

  test("이미 가졌으면 화면만 옮김", () => {
    expect(jumpRoute({ ...base, period: "5m", date: "2026-11-09", held: true })).toBe("view");
    expect(jumpRoute({ ...base, period: "D", date: "2026-11-09", held: true })).toBe("view");
  });

  test("기준 날짜가 오늘이면 화면만 옮김", () => {
    expect(jumpRoute({ ...base, period: "5m", date: "2026-11-19" })).toBe("view");
    expect(jumpRoute({ ...base, period: "5m", date: "2026-11-22" })).toBe("view");
  });

  test("분봉의 과거 날짜는 바로가기 모드", () => {
    expect(jumpRoute({ ...base, period: "1m", date: "2026-11-09" })).toBe("mode");
    expect(jumpRoute({ ...base, period: "60m", date: "2026-01-02" })).toBe("mode");
  });

  test("일·주·월봉 대상은 이어 받기", () => {
    for (const period of ["D", "W", "M"] as const) expect(jumpRoute({ ...base, period, date: "2026-01-02" })).toBe("extend");
  });
});

describe("오른쪽 끝 봉", () => {
  const interval = barInterval(kst("2026-11-09T00:00:00"), "D");
  const minutes = (day: string, from: number, count: number) => Array.from({ length: count }, (_, i) => bar(kst(`${day}T09:00:00`) + (from + i) * 300));

  test("구간 안의 마지막 봉", () => {
    const bars = [...minutes("2026-11-06", 0, 3), ...minutes("2026-11-09", 0, 4), ...minutes("2026-11-10", 0, 2)];
    expect(lastBarBefore(bars, interval)).toEqual({ index: 6, inInterval: true });
  });

  test("구간 끝까지의 봉이 모두 구간 안이면 마지막 봉", () => {
    const bars = minutes("2026-11-09", 0, 4);
    expect(lastBarBefore(bars, interval)).toEqual({ index: 3, inInterval: true });
  });

  test("구간에 봉이 없으면 직전 봉이고 구간 안이 아니다", () => {
    const bars = [...minutes("2026-11-06", 0, 3), ...minutes("2026-11-10", 0, 2)];
    expect(lastBarBefore(bars, interval)).toEqual({ index: 2, inInterval: false });
  });

  test("구간 끝 앞에 봉이 하나도 없으면 없음", () => {
    expect(lastBarBefore(minutes("2026-11-10", 0, 2), interval)).toBeNull();
    expect(lastBarBefore([], interval)).toBeNull();
  });
});

describe("이미 가졌는지", () => {
  const interval = barInterval(kst("2026-11-09T00:00:00"), "D");
  const bars = [bar(kst("2026-11-06T10:00:00")), bar(kst("2026-11-09T10:00:00"))];

  test("평소에는 구간 끝 앞의 봉이 있으면 가졌다", () => {
    expect(jumpHeld({ bars, interval, date: "2026-11-09", modeDate: null })).toBe(true);
    expect(jumpHeld({ bars: [bar(kst("2026-11-10T10:00:00"))], interval, date: "2026-11-09", modeDate: null })).toBe(false);
  });

  test("모드 중에는 같은 기준일일 때만 가졌다. 더 이르거나 늦은 날짜는 새 기준일이다", () => {
    expect(jumpHeld({ bars, interval, date: "2026-11-09", modeDate: "2026-11-09" })).toBe(true);
    expect(jumpHeld({ bars, interval, date: "2026-11-06", modeDate: "2026-11-09" })).toBe(false);
    expect(jumpHeld({ bars, interval, date: "2026-11-12", modeDate: "2026-11-09" })).toBe(false);
  });
});

describe("결과 알림", () => {
  test("옮긴 대상은 알림 하나로 묶는다", () => {
    expect(jumpNotice([{ period: "1m", outcome: "moved" }, { period: "5m", outcome: "moved" }], "2026-11-09")).toBe("1분·5분 차트를 2026-11-09 기준으로 옮겼습니다");
  });

  test("그 구간에 봉이 없으면 직전 봉까지 보인다고 알린다", () => {
    expect(jumpNotice([{ period: "5m", outcome: "previous" }], "2026-11-09")).toBe("5분 차트는 그 날 분봉이 없어 직전 봉까지 보입니다");
  });

  test("키움이 비운 응답", () => {
    expect(jumpNotice([{ period: "1m", outcome: "empty" }], "2026-01-05")).toBe("2026-01-05 분봉을 키움이 주지 않습니다 · 분봉은 대개 최근 1년까지입니다");
  });

  test("받기 실패는 같은 문구를 한 번만 보인다", () => {
    expect(jumpNotice([{ period: "1m", outcome: "failed" }, { period: "5m", outcome: "failed" }], "2026-11-09")).toBe("분봉을 받지 못했습니다");
    expect(jumpNotice([{ period: "D", outcome: "failed" }], "2026-11-09")).toBe("일봉을 받지 못했습니다");
  });

  test("옮긴 것과 실패가 섞이면 이어 붙인다. 취소만 있으면 알림이 없다", () => {
    expect(jumpNotice([{ period: "1m", outcome: "moved" }, { period: "5m", outcome: "failed" }], "2026-11-09")).toBe("1분 차트를 2026-11-09 기준으로 옮겼습니다 분봉을 받지 못했습니다");
    expect(jumpNotice([{ period: "1m", outcome: "cancelled" }], "2026-11-09")).toBeNull();
  });
});
