import { describe, expect, it } from "vitest";
import { priceToneClass } from "./TapeMatrixWindow";

describe("priceToneClass", () => {
  it("전일종가 대비 상승 호가는 매도·매수 구분 없이 tm-up을 반환한다", () => {
    expect(priceToneClass(77_000, 70_000)).toBe("tm-up");
  });

  it("전일종가 대비 하락 호가는 매도·매수 구분 없이 tm-down을 반환한다", () => {
    expect(priceToneClass(63_000, 70_000)).toBe("tm-down");
  });

  it("전일종가와 같거나 기준가가 없으면 빈 클래스를 반환한다", () => {
    expect(priceToneClass(70_000, 70_000)).toBe("");
    expect(priceToneClass(70_000, null)).toBe("");
    expect(priceToneClass(70_000, 0)).toBe("");
  });
});
