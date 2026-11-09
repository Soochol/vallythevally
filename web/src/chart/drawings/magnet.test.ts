import { describe, expect, test } from "vitest";
import { effectiveMagnet, type MagnetSource, ohlcSource, snap, WEAK_RADIUS_PX } from "./magnet";

const bars = [
  { t: 0, o: 100, h: 120, l: 90, c: 110, v: 1 },
  { t: 60, o: 110, h: 130, l: 105, c: 125, v: 1 },
];
const price = { toY: (p: number) => 500 - p };
const ohlc = ohlcSource(bars);

describe("Ctrl은 자석을 잠시 반대로 한다", () => {
  test("켜져 있으면 끈다", () => {
    expect(effectiveMagnet({ on: true, strength: "strong" }, true)).toBe("off");
  });
  test("꺼져 있으면 마지막으로 고른 세기로 켠다", () => {
    expect(effectiveMagnet({ on: false, strength: "strong" }, true)).toBe("strong");
    expect(effectiveMagnet({ on: false, strength: "weak" }, true)).toBe("weak");
  });
  test("Ctrl이 없으면 설정 그대로", () => {
    expect(effectiveMagnet({ on: true, strength: "weak" }, false)).toBe("weak");
    expect(effectiveMagnet({ on: false, strength: "strong" }, false)).toBe("off");
  });
});

test("시·고·저·종 후보", () => {
  expect(ohlc(1)).toEqual([110, 130, 105, 125]);
  expect(ohlc(5)).toEqual([]);
});

describe("snap", () => {
  test("끔: 그대로", () => {
    expect(snap({ logical: 0.4, price: 111, y: 389 }, "off", [ohlc], price)).toEqual({ logical: 0.4, price: 111, onCandidate: false });
  });

  test("약: 가장 가까운 봉과 16px 안의 값", () => {
    expect(snap({ logical: 0.6, price: 128, y: 372 }, "weak", [ohlc], price)).toEqual({ logical: 1, price: 130, onCandidate: true });
  });

  test("약: 16px 밖이면 시각만 붙고 가격은 마우스 그대로", () => {
    const y = 500 - 130 - (WEAK_RADIUS_PX + 1);
    expect(snap({ logical: 1.2, price: 500 - y, y }, "weak", [ohlc], price)).toEqual({ logical: 1, price: 500 - y, onCandidate: false });
  });

  test("강: 거리와 상관없이 붙는다", () => {
    expect(snap({ logical: 1.2, price: 300, y: 200 }, "strong", [ohlc], price)).toEqual({ logical: 1, price: 130, onCandidate: true });
  });

  test("미래 봉은 후보가 없어 시각만 붙는다", () => {
    expect(snap({ logical: 6.7, price: 300, y: 200 }, "strong", [ohlc], price)).toEqual({ logical: 7, price: 300, onCandidate: false });
  });

  test("후보 원천을 여럿 받는다", () => {
    const indicator: MagnetSource = (i) => (i === 0 ? [101] : []);
    expect(snap({ logical: 0, price: 101.5, y: 398.5 }, "weak", [ohlc, indicator], price).price).toBe(101);
  });

  test("첫 봉 왼쪽은 첫 봉에 붙는다", () => {
    expect(snap({ logical: -0.7, price: 120, y: 380 }, "weak", [ohlc], price)).toEqual({ logical: 0, price: 120, onCandidate: true });
  });
});
