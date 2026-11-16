import { expect, test } from "vitest";
import { isVenue, shownVenue } from "./venue";

const samsung = { code: "005930", nxtEnabled: true };
const samsungPref = { code: "005935", nxtEnabled: false };
const kospi = { code: "IDX:001", nxtEnabled: false };

test("주소의 거래소 값은 셋 중 하나만 받는다", () => {
  expect(isVenue("krx")).toBe(true);
  expect(isVenue("KRX")).toBe(false);
  expect(isVenue("")).toBe(false);
});

test("지수는 앱 전체 거래소와 상관없이 거래소가 없다", () => {
  expect(shownVenue(kospi.code, "krx", kospi)).toBeNull();
  expect(shownVenue(kospi.code, "nxt", undefined)).toBeNull();
});

test("주식은 앱 전체 거래소를 그대로 보인다", () => {
  expect(shownVenue(samsung.code, "krx", samsung)).toBe("krx");
  expect(shownVenue(samsung.code, "nxt", samsung)).toBe("nxt");
  expect(shownVenue(samsungPref.code, "krx", samsungPref)).toBe("krx");
  expect(shownVenue(samsungPref.code, "combined", samsungPref)).toBe("combined");
});

test("NXT에서 거래되지 않는 종목은 NXT일 때 통합으로 보인다", () => {
  expect(shownVenue(samsungPref.code, "nxt", samsungPref)).toBe("combined");
});

test("종목 정보가 없으면(받는 중·실패) NXT만 통합으로 그린다", () => {
  expect(shownVenue("005930", "nxt", undefined)).toBe("combined");
  expect(shownVenue("005930", "krx", undefined)).toBe("krx");
  expect(shownVenue("005930", "combined", undefined)).toBe("combined");
});
