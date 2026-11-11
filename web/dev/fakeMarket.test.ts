import { expect, test } from "vitest";
import { barsPage, findSymbol, publicInfo, resolveVenue, search, seriesOf } from "./fakeMarket.ts";

const now = Date.UTC(2026, 10, 9, 3, 0); // 2026-11-09(월) 12:00 KST

test("최신 페이지의 current는 오늘 봉이고 종가가 고정값이다", () => {
  const page = barsPage(findSymbol("005930")!, "combined", "D", 500, null, now);
  expect(page.bars).toHaveLength(500);
  expect(page.current?.c).toBe(193500);
  expect(page.current?.t).toBe(Date.UTC(2026, 10, 9) / 1000 - 32400);
  expect(page.bars.at(-1)!.t).toBeLessThan(page.current!.t);
  expect(barsPage(findSymbol("IDX:001")!, null, "D", 500, null, now).current?.c).toBe(5059.69);
});

test("nextBefore를 따라가면 겹치지 않는 과거 페이지가 이어지다 null로 끝난다", () => {
  const s = findSymbol("005930")!;
  let page = barsPage(s, "combined", "D", 500, null, now);
  let total = page.bars.length;
  let pages = 1;
  while (page.nextBefore !== null) {
    const older = barsPage(s, "combined", "D", 500, page.nextBefore, now);
    expect(older.current).toBeNull();
    expect(older.bars.at(-1)!.t).toBeLessThan(page.nextBefore);
    total += older.bars.length;
    page = older;
    pages++;
  }
  expect(pages).toBe(4);
  expect(total).toBe(7 * 250 - 1);
});

test("주봉은 월요일, 월봉은 1일 00:00 KST에 시작한다", () => {
  const s = findSymbol("005930")!;
  const w = barsPage(s, "combined", "W", 500, null, now).current!;
  const m = barsPage(s, "combined", "M", 500, null, now).current!;
  expect(w.t).toBe(Date.UTC(2026, 10, 9) / 1000 - 32400);
  expect(m.t).toBe(Date.UTC(2026, 10, 1) / 1000 - 32400);
});

test("초성 검색 순서는 서버 규칙(D5)을 흉내 낸다", () => {
  expect(search("ㅅㅅ").map((s) => s.name)).toEqual([
    "삼성물산", "삼성바이오로직스", "삼성생명", "삼성전기", "삼성전자", "삼성SDI", "신세계", "삼성전자우",
  ]);
  expect(search("ㅅㅅㅈㅈ").map((s) => s.code)).toEqual(["005930", "005935"]);
  expect(search(" 005930 ")[0]?.name).toBe("삼성전자");
  expect(search("")).toEqual([]);
});

const samsung = findSymbol("005930")!;
const samsungPref = findSymbol("005935")!;
const kospi = findSymbol("IDX:001")!;
const KST = 32400;
const kstClock = (t: number) => new Date((t + KST) * 1000).toISOString().slice(11, 16);

test("종목 정보는 nxtEnabled를 준다", () => {
  expect(publicInfo(samsung).nxtEnabled).toBe(true);
  expect(publicInfo(samsungPref).nxtEnabled).toBe(false);
  expect(publicInfo(kospi).nxtEnabled).toBe(false);
});

test("venue 규칙: 주식은 없으면 통합, 지수에 주면 오류, NXT 불가 종목에 nxt면 오류", () => {
  expect(resolveVenue(samsung, null)).toEqual({ venue: "combined" });
  expect(resolveVenue(samsung, "nxt")).toEqual({ venue: "nxt" });
  expect(resolveVenue(samsungPref, "krx")).toEqual({ venue: "krx" });
  expect(resolveVenue(samsungPref, "nxt")).toHaveProperty("error");
  expect(resolveVenue(kospi, null)).toEqual({ venue: null });
  expect(resolveVenue(kospi, "combined")).toHaveProperty("error");
  expect(resolveVenue(samsung, "KRX")).toHaveProperty("error");
});

test("같은 종목, 같은 날이라도 거래소마다 가격이 다르다", () => {
  for (const period of ["D", "5m"] as const) {
    const [c, k, n] = (["combined", "krx", "nxt"] as const).map((v) => barsPage(samsung, v, period, 500, null, now));
    const t = n!.bars.at(-1)!.t;
    const at = (p: typeof c) => p!.bars.find((b) => b.t === t)!;
    expect(at(c).t).toBe(at(k).t);
    expect(new Set([at(c).c, at(k).c, at(n).c]).size).toBe(3);
    expect(k!.venue).toBe("krx");
  }
  expect(barsPage(kospi, null, "D", 1, null, now).venue).toBeNull();
});

test("통합 일봉은 그대로다(오늘 종가가 고정값)", () => {
  expect(barsPage(samsung, "combined", "D", 1, null, now).current?.c).toBe(193500);
});

test("NXT 일봉은 2025-03-04부터다", () => {
  let page = barsPage(samsung, "nxt", "D", 1000, null, now);
  while (page.nextBefore !== null) page = barsPage(samsung, "nxt", "D", 1000, page.nextBefore, now);
  expect(page.bars[0]!.t).toBe(Date.UTC(2025, 2, 4) / 1000 - KST);
});

test("분봉은 KST 거래 시간 안에 있고 n분의 배수에서 시작한다", () => {
  const krx = barsPage(samsung, "krx", "5m", 1000, null, now).bars;
  expect(krx.every((b) => kstClock(b.t) >= "09:00" && kstClock(b.t) < "15:30")).toBe(true);
  expect(krx.every((b) => ((b.t + KST) / 60) % 5 === 0)).toBe(true);
  const nxt = barsPage(samsung, "nxt", "60m", 1000, null, now).bars;
  expect(nxt.some((b) => kstClock(b.t) === "08:00")).toBe(true);
  expect(nxt.some((b) => kstClock(b.t) === "19:00")).toBe(true);
  const idx = barsPage(kospi, null, "1m", 1000, null, now).bars;
  expect(idx.some((b) => kstClock(b.t) === "15:29")).toBe(true);
  expect(idx.every((b) => kstClock(b.t) >= "09:00" && kstClock(b.t) < "15:30")).toBe(true);
});

test("오늘 분봉은 지금까지만 있고 현재 봉이 지금 구간이다", () => {
  const page = barsPage(samsung, "combined", "1m", 10, null, now);
  expect(page.current?.t).toBe(Date.UTC(2026, 10, 9, 3, 0) / 1000);
});

test("분봉은 최근 1년에서 끝난다. 그 끝에서 nextBefore가 null이다", () => {
  let page = barsPage(samsung, "combined", "1m", 1000, null, now);
  let pages = 1;
  while (page.nextBefore !== null) {
    const older = barsPage(samsung, "combined", "1m", 1000, page.nextBefore, now);
    expect(older.bars.at(-1)!.t).toBeLessThan(page.nextBefore);
    page = older;
    pages++;
  }
  const oldest = page.bars[0]!.t;
  expect(now / 1000 - oldest).toBeLessThanOrEqual(365 * 86400);
  expect(now / 1000 - oldest).toBeGreaterThan(360 * 86400);
  expect(pages).toBeGreaterThan(100);
});


test("분기·연간 개발 차트도 달력 경계와 OHLCV를 보존한다", () => {
  for (const period of ["Q", "Y"] as const) {
    const bars = seriesOf(samsung, "combined", period, now);
    const current = bars.at(-1)!;
    const first = Date.UTC(2026, period === "Q" ? 9 : 0, 1) / 1000 - KST;
    const daily = seriesOf(samsung, "combined", "D", now).filter((b) => b.t >= first);
    expect(current).toEqual({
      t: first,
      o: daily[0]!.o,
      h: Math.max(...daily.map((b) => b.h)),
      l: Math.min(...daily.map((b) => b.l)),
      c: daily.at(-1)!.c,
      v: daily.reduce((sum, b) => sum + b.v, 0),
    });
    expect(bars.every((b) => Number.isFinite(b.t) && Number.isFinite(b.c))).toBe(true);
  }
});


test("10분봉 개발 차트는 1분봉 열 개의 OHLCV를 보존한다", () => {
  const ten = seriesOf(samsung, "combined", "10m", now)[0]!;
  const minutes = seriesOf(samsung, "combined", "1m", now).filter((b) => ten.t <= b.t && b.t < ten.t + 600);
  expect(minutes).toHaveLength(10);
  expect(ten).toEqual({
    t: minutes[0]!.t,
    o: minutes[0]!.o,
    h: Math.max(...minutes.map((b) => b.h)),
    l: Math.min(...minutes.map((b) => b.l)),
    c: minutes.at(-1)!.c,
    v: minutes.reduce((sum, b) => sum + b.v, 0),
  });
});
