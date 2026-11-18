import { describe, expect, it } from "vitest";
import { sharePercent, sideLabel, speakSize } from "./DockSizeBalloon";

describe("크기 말풍선 글", () => {
  it("이름이 있으면 이름과 px를, 없으면 px만 적는다", () => {
    expect(sideLabel({ name: "차트", px: 1012 })).toBe("차트 1012px");
    expect(sideLabel({ name: null, px: 398 })).toBe("398px");
  });
  it("앞쪽 몫을 퍼센트로 반올림한다", () => {
    expect(sharePercent(1012, 398)).toBe(72);
    expect(sharePercent(0, 0)).toBe(0);
  });
  it("화면 읽기용 값에 픽셀과 퍼센트를 적는다", () => {
    expect(speakSize({ name: "차트", px: 1012 }, 72)).toBe("차트 1012픽셀, 72퍼센트");
    expect(speakSize({ name: null, px: 500 }, 50)).toBe("500픽셀, 50퍼센트");
  });
});
