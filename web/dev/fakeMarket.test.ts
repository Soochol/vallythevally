import { expect, test } from "vitest";
import { barsPage, findSymbol, search } from "./fakeMarket.ts";

const now = Date.UTC(2026, 10, 9, 3, 0); // 2026-11-09(월) 12:00 KST

test("최신 페이지의 current는 오늘 봉이고 종가가 고정값이다", () => {
  const page = barsPage(findSymbol("005930")!, "D", 500, null, now);
  expect(page.bars).toHaveLength(500);
  expect(page.current?.c).toBe(193500);
  expect(page.current?.t).toBe(Date.UTC(2026, 10, 9) / 1000 - 32400);
  expect(page.bars.at(-1)!.t).toBeLessThan(page.current!.t);
  expect(barsPage(findSymbol("IDX:001")!, "D", 500, null, now).current?.c).toBe(5059.69);
});

test("nextBefore를 따라가면 겹치지 않는 과거 페이지가 이어지다 null로 끝난다", () => {
  const s = findSymbol("005930")!;
  let page = barsPage(s, "D", 500, null, now);
  let total = page.bars.length;
  let pages = 1;
  while (page.nextBefore !== null) {
    const older = barsPage(s, "D", 500, page.nextBefore, now);
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
  const w = barsPage(s, "W", 500, null, now).current!;
  const m = barsPage(s, "M", 500, null, now).current!;
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
