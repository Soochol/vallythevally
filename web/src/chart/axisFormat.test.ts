import { expect, test, vi } from "vitest";
import { axisPriceFormat, distinctAxisTicks, financialAxisUnit, fitAxisValue, formatAxisTicks, formatAxisValue, priceAxisWidth } from "./axisFormat";

test.each([
  [-48_054_251_000_000, "KRW", "−48.1조"],
  [1_648_000_000, "KRW", "16.48억"],
  [3_120_000, "volume", "3.12M"],
  [-1_648_000_000, "volume", "−1.65B"],
  [128_000_000, "volume", "128M"],
  [0, "volume", "0"],
  [950, "volume", "950"],
  [1_300_000, "price", "1,300,000"],
  [1_300_000_000, "price", "1,300,000,000"],
  [1_300_000, "index", "1,300,000"],
  [44.23, "%", "44.23%"],
  [-12.5, "%", "−12.5%"],
  [1_200, "원/주", "1.2K원/주"],
  [2_000, "원/주", "2K원/주"],
  [0, "원/주", "0원/주"],
] as const)("축 %s %s → %s", (value, unit, expected) => {
  expect(formatAxisValue(value, unit)).toBe(expected);
});

test("금액은 원화와 다른 통화를 구별하고 비율·주당 배당 단위를 보존한다", () => {
  expect(financialAxisUnit("investing_cash_flow", "KRW")).toBe("KRW");
  expect(formatAxisValue(1_300_000, financialAxisUnit("revenue", "USD"))).toBe("1.3MUSD");
  expect(financialAxisUnit("owner_roe", "KRW")).toBe("%");
  expect(financialAxisUnit("debt_ratio", "KRW")).toBe("%");
  expect(financialAxisUnit("dps", "KRW")).toBe("원/주");
});

test("축 좌표로 로그와 선형의 충돌을 판정하고 눈금을 모두 지우지 않는다", () => {
  const geometry = { toCoordinate: (value: number) => Math.log10(value) * 30, lastCoordinates: () => [90] };
  expect(formatAxisTicks([10, 100, 1000, 10000], ["10", "100", "1000", "10000"], geometry, 11)).toEqual(["10", "100", "", "10000"]);
  const crowded = { toCoordinate: (value: number) => value, lastCoordinates: () => [20] };
  expect(formatAxisTicks([19, 20, 21], ["19", "20", "21"], crowded, 11).filter(Boolean)).toHaveLength(1);
  expect(formatAxisTicks([20], ["20"], crowded, 11)).toEqual(["20"]);
});

test("가격 눈금은 쉼표 숫자이고 폭이 좁을 때만 만 단위로 줄며 영문 M이 없다", () => {
  const values = [1_160_000, 1_200_000, 1_240_000, 1_280_000, 1_320_000, 1_360_000, 1_400_000, 1_440_000, 1_480_000, 1_520_000, 1_560_000, 1_600_000, 1_640_000];
  const wide = distinctAxisTicks(values, "price", () => true);
  expect(wide[0]).toBe("1,160,000");
  expect(wide.at(-1)).toBe("1,640,000");
  const narrow = distinctAxisTicks(values, "price", (text) => text.length <= 4);
  expect(narrow.slice(0, 3)).toEqual(["116만", "120만", "124만"]);
  expect(new Set(narrow).size).toBe(values.length);
  const halves = distinctAxisTicks([1_440_000, 1_445_000, 1_450_000], "price", (text) => text.length <= 6);
  expect(halves).toEqual(["144만", "144.5만", "145만"]);
  for (const label of [...wide, ...narrow]) expect(label).not.toMatch(/[KMBT]/);
  expect(fitAxisValue(1_440_000, "index", (text) => text.length <= 4)).toBe("144만");
});

test("거래량 눈금은 가장 큰 값의 영문 단위 하나로 맞추고 한국식 단위를 쓰지 않는다", () => {
  const always = () => true;
  expect(distinctAxisTicks([0, 50_000_000, 100_000_000, 150_000_000, 200_000_000], "volume", always)).toEqual(["0", "50M", "100M", "150M", "200M"]);
  expect(distinctAxisTicks([0, 20_000, 40_000, 60_000, 80_000, 100_000], "volume", always)).toEqual(["0", "20K", "40K", "60K", "80K", "100K"]);
  expect(distinctAxisTicks([0, 500_000_000, 1_000_000_000, 1_500_000_000], "volume", always)).toEqual(["0", "0.5B", "1B", "1.5B"]);
  expect(distinctAxisTicks([0, 200, 400, 600], "volume", always)).toEqual(["0", "200", "400", "600"]);
  expect(distinctAxisTicks([3_120_000, 3_121_000, 3_122_000], "volume", always)).toEqual(["3.12M", "3.121M", "3.122M"]);
  for (const label of [...distinctAxisTicks([0, 30_000_000, 200_000_000], "volume", always), formatAxisValue(1_234_567_890_123, "volume")]) {
    expect(label).not.toMatch(/[만억조]/);
  }
});

test("축 폭이 부족하면 단위를 남기고 소수·구분자·큰 수 표기를 줄인다", () => {
  expect(fitAxisValue(-1234.56, "index", (text) => text.length <= 6)).toBe("−1,235");
  expect(fitAxisValue(70000, "price", (text) => text.length <= 4)).toBe("7만");
  expect(fitAxisValue(1_234_567_890_000_000_000, "원/주", (text) => text.length <= 7)).toBe("1e18원/주");
});

test.each([
  ["KRW", [-48_140_000_000_000, -48_130_000_000_000, -48_120_000_000_000]],
  ["volume", [3120000, 3121000, 3122000]],
  ["KRW", [1_648_000_000, 1_649_000_000, 1_650_000_000]],
  [{ currency: "USD" }, [1_200_000_000, 1_300_000_000, 1_400_000_000]],
  ["price", [1296000, 1296100, 1296200]],
  ["%", [129600, 129610, 129620]],
  ["원/주", [1200, 1210, 1220]],
] as const)("%s 눈금의 최종 표기는 모두 구분된다", (unit, values) => {
  const format = axisPriceFormat(unit, 0.01);
  const labels = format.tickmarksFormatter([...values]);
  expect(labels.every((label) => label.length > 0)).toBe(true);
  expect(new Set(labels).size).toBe(values.length);
});

test.each([
  ["KRW", [-48_140_000_000_000, -48_130_000_000_000, -48_120_000_000_000]],
  ["volume", [3120000, 3121000, 3122000]],
  ["KRW", [1_648_000_000, 1_649_000_000, 1_650_000_000]],
  [{ currency: "USD" }, [1_200_000_000, 1_300_000_000, 1_400_000_000]],
  ["price", [1296000, 1296100, 1296200]],
  ["%", [129600, 129610, 129620]],
  ["원/주", [1200, 1300, 1400]],
] as const)("%s 눈금은 폭을 맞춘 최종 문자열도 구분된다", (unit, values) => {
  const labels = distinctAxisTicks([...values], unit, (text) => text.length <= 8);
  expect(labels.every((label) => label.length > 0 && label.length <= 8)).toBe(true);
  expect(new Set(labels).size).toBe(values.length);
});

test("극단 값이나 긴 통화 단위도 지수 표기로 남기고 다음 패널 표기를 계속한다", () => {
  const fits = (text: string) => text.length <= 8;
  for (const value of [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE]) {
    expect(fitAxisValue(value, { currency: "확인하지 못한 아주 긴 통화 단위" }, fits).length).toBeLessThanOrEqual(8);
  }
  expect(fitAxisValue(1_648_000_000, "KRW", fits)).toBe("16.48억");
});

test("충돌 보조 기능이 실패하면 폭에 맞춘 기본 눈금을 남기고 복구를 요청한다", () => {
  const failed = vi.fn();
  const formatted = vi.fn();
  const format = axisPriceFormat("KRW", 0.01, { lastCoordinates: () => { throw new Error("pane is changing"); }, toCoordinate: () => null, failed, formatted });
  expect(format.tickmarksFormatter([-48_100_000_000_000, -48_000_000_000_000])).toEqual(["−48.1조", "−48조"]);
  expect(failed).toHaveBeenCalledTimes(1);
  expect(formatted).toHaveBeenCalledTimes(1);
});

test("맞는 첫 포맷 후보 뒤의 숫자 변환은 계산하지 않는다", () => {
  const locale = vi.spyOn(Number.prototype, "toLocaleString");
  const descriptor = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, "format");
  if (!descriptor?.get) throw new Error("Intl 숫자 포맷터 getter 없음");
  const get = descriptor.get;
  let formatCalls = 0;
  Object.defineProperty(Intl.NumberFormat.prototype, "format", { ...descriptor, get(this: Intl.NumberFormat) { formatCalls++; return get.call(this); } });
  try {
    expect(fitAxisValue(193400, "price", () => true)).toBe("193,400");
    expect(locale.mock.calls.length + formatCalls).toBe(1);
    locale.mockClear();
    formatCalls = 0;
    expect(distinctAxisTicks([190000, 200000, 210000], "price", () => true)).toEqual(["190,000", "200,000", "210,000"]);
    expect(locale.mock.calls.length + formatCalls).toBe(3);
  } finally {
    locale.mockRestore();
    Object.defineProperty(Intl.NumberFormat.prototype, "format", descriptor);
  }
});

function stubCanvasText(glyphEm: number) {
  let font = "";
  const context = {
    set font(value: string) { font = value; },
    measureText: (text: string) => ({ width: text.length * Number.parseFloat(font) * glyphEm }),
  };
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => context, setAttribute: () => undefined }), body: { append: () => undefined }, documentElement: {} });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (name: string) => name === "--fs-xs" ? "11px" : "sans-serif" }));
  return { mockRestore: () => vi.unstubAllGlobals() };
}

test("축 폭은 6자리 이하는 72px이고 7자리 가격부터 80·88px로 넓어지며 글자는 줄이지 않는다", () => {
  const canvas = stubCanvasText(0.55);
  try {
    expect(priceAxisWidth(193_400, 11)).toBe(72);
    expect(priceAxisWidth(1_160_000, 11)).toBe(80);
    expect(priceAxisWidth(1_523_000, 11)).toBe(80);
    expect(priceAxisWidth(99_999_999, 11)).toBe(88);
    expect(priceAxisWidth(123_456_789, 11)).toBe(88);
    expect(priceAxisWidth(Number.NaN, 11)).toBe(72);
  } finally {
    canvas.mockRestore();
  }
});

test("가격 눈금은 현재 축 폭으로 맞춰 7자리 가격에서 폭을 넓히면 쉼표 숫자를 남긴다", () => {
  const canvas = stubCanvasText(0.55);
  let width = 72;
  try {
    const geometry = { width: () => width, toCoordinate: () => null, lastCoordinates: () => [] };
    const values = [1_160_000, 1_200_000, 1_240_000];
    expect(axisPriceFormat("price", 1, geometry).tickmarksFormatter(values)).toEqual(["116만", "120만", "124만"]);
    width = priceAxisWidth(1_240_000, 11);
    expect(axisPriceFormat("price", 1, geometry).tickmarksFormatter(values)).toEqual(["1,160,000", "1,200,000", "1,240,000"]);
    expect(axisPriceFormat("price", 1, geometry).formatter(1_160_000)).toBe("1,160,000");
  } finally {
    canvas.mockRestore();
  }
});
