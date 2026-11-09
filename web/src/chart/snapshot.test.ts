import { expect, test } from "vitest";
import type { ShownVenue } from "../lib/venue";
import { snapshotFileName } from "./snapshot";

// 2026-11-09 14:32 KST
const takenAt = Date.UTC(2026, 10, 9, 14, 32) / 1000 - 32400;

test("파일 이름은 종목, 거래소, 봉 주기, 한국 시각이다", () => {
  expect(snapshotFileName("005930", "krx" as ShownVenue, "5m", takenAt)).toBe("005930_krx_5m_20261109-1432.png");
});

test("지수는 거래소를 빼고 이름을 짓는다", () => {
  expect(snapshotFileName("IDX:001", null, "D", takenAt)).toBe("IDX-001_D_20261109-1432.png");
});
