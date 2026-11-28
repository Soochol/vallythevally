import { describe, expect, it } from "vitest";
import { rowsPerSideFor, visibleLadderRows } from "./useRowsPerSide";

describe("rowsPerSideFor", () => {
  it("높이를 모르는 0은 전체 10단으로 본다", () => expect(rowsPerSideFor(0)).toBe(10));
  it("20줄과 여백이 들어가는 492px는 10단이다", () => expect(rowsPerSideFor(492)).toBe(10));
  it("그보다 커도 10단을 넘지 않는다", () => expect(rowsPerSideFor(2000)).toBe(10));
  it("48px가 모자라면 한 단씩 줄어든다", () => {
    expect(rowsPerSideFor(491)).toBe(9);
    expect(rowsPerSideFor(444)).toBe(9);
    expect(rowsPerSideFor(443)).toBe(8);
  });
  it("가장 낮은 창 높이 108px는 2단이다", () => expect(rowsPerSideFor(108)).toBe(2));
  it("그보다 낮아도 2단 밑으로 내려가지 않는다", () => {
    expect(rowsPerSideFor(107)).toBe(2);
    expect(rowsPerSideFor(1)).toBe(2);
  });
  it("초촘촘(16px)이면 332px, 촘촘(20px)이면 412px, 여유(30px)면 612px에 10단이 들어간다", () => {
    expect(rowsPerSideFor(332, 16)).toBe(10);
    expect(rowsPerSideFor(331, 16)).toBe(9);
    expect(rowsPerSideFor(332, 20)).toBe(8);
    expect(rowsPerSideFor(412, 24)).toBe(8);
    expect(rowsPerSideFor(412, 20)).toBe(10);
    expect(rowsPerSideFor(411, 20)).toBe(9);
    expect(rowsPerSideFor(612, 30)).toBe(10);
    expect(rowsPerSideFor(611, 30)).toBe(9);
    expect(rowsPerSideFor(492, 30)).toBe(8);
  });
});

describe("visibleLadderRows", () => {
  const rows = Array.from({ length: 20 }, (_, index) => index);
  it("10단이면 전체를 그대로 준다", () => expect(visibleLadderRows(rows, 10)).toBe(rows));
  it("줄어든 단수는 매도 최우선과 매수 최우선 둘레를 같은 수만큼 남긴다", () => {
    expect(visibleLadderRows(rows, 3)).toEqual([7, 8, 9, 10, 11, 12]);
  });
});
