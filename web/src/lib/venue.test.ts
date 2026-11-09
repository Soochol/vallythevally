import { expect, test } from "vitest";
import { isVenue, shownVenue, venueFor } from "./venue";

const samsung = { code: "005930", nxtEnabled: true };
const samsungPref = { code: "005935", nxtEnabled: false };
const kospi = { code: "IDX:001", nxtEnabled: false };

test("지수는 언제나 거래소가 없다", () => {
  expect(venueFor(kospi, "krx")).toBeNull();
  expect(venueFor(kospi, null)).toBeNull();
});

test("지수에서 주식으로 오면 통합이다", () => {
  expect(venueFor(samsung, null)).toBe("combined");
});

test("주식끼리는 허용되는 거래소를 유지한다", () => {
  expect(venueFor(samsung, "krx")).toBe("krx");
  expect(venueFor(samsung, "nxt")).toBe("nxt");
  expect(venueFor(samsungPref, "krx")).toBe("krx");
});

test("NXT 불가 종목으로 가면 NXT는 통합이 된다", () => {
  expect(venueFor(samsungPref, "nxt")).toBe("combined");
});

test("주소의 거래소 값은 셋 중 하나만 받는다", () => {
  expect(isVenue("krx")).toBe(true);
  expect(isVenue("KRX")).toBe(false);
  expect(isVenue("")).toBe(false);
});

test("그리는 거래소: 종목 정보가 있으면 저장된 거래소를 그 정보로 확인한다", () => {
  expect(shownVenue("nxt", samsung)).toBe("nxt");
  expect(shownVenue("nxt", samsungPref)).toBe("combined");
  expect(shownVenue("krx", samsungPref)).toBe("krx");
  expect(shownVenue(null, kospi)).toBeNull();
});

test("그리는 거래소: 종목 정보가 없으면(받는 중·실패) NXT만 통합으로 그린다", () => {
  expect(shownVenue("nxt", undefined)).toBe("combined");
  expect(shownVenue("krx", undefined)).toBe("krx");
  expect(shownVenue("combined", undefined)).toBe("combined");
  expect(shownVenue(null, undefined)).toBeNull();
});
