import { expect, test } from "vitest";
import { quoteInfoItems } from "./quoteInfo";

const input = {
  price: 70_300,
  previousClose: 70_000,
  summary: null,
  fundamentals: { upperLimit: 91_000, lowerLimit: 49_000, marketCap: 82_400_000_000 },
};
const VI = { up: 77_000, down: 63_000, triggered: null };
const page2 = (vi: Parameters<typeof quoteInfoItems>[1]["vi"]) => quoteInfoItems(1, { ...input, vi });
const row = (lines: ReturnType<typeof page2>, at: number) => lines[at]!.item;

test("종목 쪽은 하한가 바로 아래에 상승VI와 하락VI가 있고 눌러 바뀌는 칸이 아니다", () => {
  const lines = page2(VI);
  expect(lines.map((line) => line.item.label)).toEqual(["상한가", "하한가", "상승VI", "하락VI", "시가총액"]);
  expect([row(lines, 2), row(lines, 3)]).toEqual([{ label: "상승VI", value: "77,000", tone: "up" }, { label: "하락VI", value: "63,000", tone: "down" }]);
  expect(lines.slice(2, 4).map((line) => line.key)).toEqual([undefined, undefined]);
});

test("발동 중이면 그 방향 칸만 발동가와 경고색이고 반대 칸은 계산값이다", () => {
  const up = page2({ ...VI, triggered: { direction: "up", price: 77_100 } });
  expect([row(up, 2), row(up, 3)]).toEqual([{ label: "상승VI 발동", value: "77,100", tone: "warning" }, { label: "하락VI", value: "63,000", tone: "down" }]);
  const down = page2({ ...VI, triggered: { direction: "down", price: 62_900 } });
  expect([row(down, 2), row(down, 3)]).toEqual([{ label: "상승VI", value: "77,000", tone: "up" }, { label: "하락VI 발동", value: "62,900", tone: "warning" }]);
});

test("발동가를 모르면 계산값을 발동 칸에 두고 값을 모르면 대시다", () => {
  expect(row(page2({ ...VI, triggered: { direction: "up", price: null } }), 2)).toEqual({ label: "상승VI 발동", value: "77,000", tone: "warning" });
  for (const vi of [null, undefined, { up: null, down: null, triggered: null }]) {
    const lines = page2(vi);
    expect([row(lines, 2), row(lines, 3)]).toEqual([{ label: "상승VI", value: "-", tone: null }, { label: "하락VI", value: "-", tone: null }]);
  }
});

test("계산값의 색은 칸 이름이 아니라 전일 종가와 비교해 정한다", () => {
  const tones = (previousClose: number | null) => {
    const lines = quoteInfoItems(1, { ...input, previousClose, vi: { up: 55_000, down: 45_000, triggered: null } });
    return [row(lines, 2).tone, row(lines, 3).tone];
  };
  expect([41_000, 60_000, 45_000, null].map(tones)).toEqual([["up", "up"], ["down", "down"], ["up", null], [null, null]]);
});
