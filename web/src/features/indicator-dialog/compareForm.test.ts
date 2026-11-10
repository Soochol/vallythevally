import { expect, test } from "vitest";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { addButton, pressScale, stepIndex } from "./compareForm";

const info = (code: string, name: string): SymbolInfo => ({ code, name, kind: "common", market: "kospi", nxtEnabled: false });
const hynix = info("000660", "SK하이닉스");
const samsung = info("005930", "삼성전자");

test("로그와 %는 서로 바꾸고, 켜진 단추를 다시 누르면 일반 축이다", () => {
  expect(pressScale({ scale: "normal", compare: [] }, "log")).toBe("log");
  expect(pressScale({ scale: "log", compare: [] }, "log")).toBe("normal");
  expect(pressScale({ scale: "percent", compare: [] }, "log")).toBe("log");
  expect(pressScale({ scale: "normal", compare: [] }, "percent")).toBe("percent");
  expect(pressScale({ scale: "log", compare: [] }, "percent")).toBe("percent");
  expect(pressScale({ scale: "percent", compare: [] }, "percent")).toBe("normal");
});

test("비교 종목이 있는 동안에는 어느 단추도 축을 바꾸지 않는다", () => {
  for (const scale of ["normal", "log", "percent"] as const) {
    expect(pressScale({ scale, compare: ["000660"] }, "log")).toBeNull();
    expect(pressScale({ scale, compare: ["000660"] }, "percent")).toBeNull();
  }
});

test("추가 단추는 고른 종목 이름을 말하고, 넣을 수 없으면 꺼지며 이유를 적는다", () => {
  expect(addButton({ compare: [] }, null, "005930")).toEqual({ label: "비교 종목 추가", ok: false, reason: null });
  expect(addButton({ compare: [] }, hynix, "005930")).toEqual({ label: "SK하이닉스 추가", ok: true, reason: null });
  expect(addButton({ compare: ["000660"] }, hynix, "005930")).toEqual({ label: "SK하이닉스 추가", ok: false, reason: "이미 넣은 비교 종목입니다" });
  expect(addButton({ compare: [] }, samsung, "005930")).toEqual({ label: "삼성전자 추가", ok: false, reason: "이 칸의 종목입니다" });
  const full = { compare: ["035420", "IDX:001", "373220"] };
  expect(addButton(full, hynix, "005930")).toEqual({ label: "SK하이닉스 추가", ok: false, reason: "비교 종목은 3개까지입니다" });
  expect(addButton(full, null, "005930")).toEqual({ label: "비교 종목 추가", ok: false, reason: "비교 종목은 3개까지입니다" });
});

test("목록 이동은 양 끝에서 돌고, 고른 것이 없으면 처음이나 끝에서 시작한다", () => {
  expect(stepIndex(-1, 1, 3)).toBe(0);
  expect(stepIndex(-1, -1, 3)).toBe(2);
  expect(stepIndex(0, 1, 3)).toBe(1);
  expect(stepIndex(2, 1, 3)).toBe(0);
  expect(stepIndex(0, -1, 3)).toBe(2);
  expect(stepIndex(-1, 1, 0)).toBe(-1);
});
