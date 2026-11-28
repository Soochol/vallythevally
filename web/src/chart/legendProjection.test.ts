import { describe, expect, test } from "vitest";
import { denserTier, indicatorRowsFolded, legendTier, MAX_TOP_MARGIN, MIN_TOP_MARGIN, priceTopMargin } from "./legendProjection";

const measured = (chartWidth: number, paneHeight: number, phone = false) => legendTier({ chartWidth, paneHeight, phone });

describe("범례 단계", () => {
  test("데스크톱 320px 이상 칸은 크기와 패널 높이에 관계없이 압축 단계로 통일한다", () => {
    expect(measured(1440, 600)).toBe("compact");
    expect(measured(480, 300)).toBe("compact");
    expect(measured(479, 600)).toBe("compact");
    expect(measured(1440, 299)).toBe("compact");
    expect(measured(320, 600)).toBe("compact");
  });

  test("칸 폭이 320px 미만이면 최소이고 가격 패널 높이와 무관하다", () => {
    expect(measured(319, 600)).toBe("minimal");
    expect(measured(280, 100)).toBe("minimal");
  });

  test("휴대폰은 칸 크기와 무관하게 최소로 고정한다", () => {
    expect(measured(1440, 900, true)).toBe("minimal");
    expect(measured(390, 500, true)).toBe("minimal");
  });

  test("더 촘촘한 단계는 압축 다음 최소이고 최소 다음은 없다", () => {
    expect(denserTier("compact")).toBe("minimal");
    expect(denserTier("minimal")).toBeNull();
  });

  test("같은 칸 크기는 항상 같은 단계다", () => {
    const first = Array.from({ length: 10 }, () => measured(640, 420));
    expect(new Set(first).size).toBe(1);
  });
});

describe("지표 줄 접기", () => {
  test("가격 패널 지표가 셋을 넘으면 접고 셋까지는 펼친다", () => {
    expect(indicatorRowsFolded("compact", 3, false)).toBe(false);
    expect(indicatorRowsFolded("compact", 4, false)).toBe(true);
    expect(indicatorRowsFolded("compact", 7, false)).toBe(true);
  });

  test("펼침을 고정해 두면 넷 이상도 접지 않는다", () => {
    expect(indicatorRowsFolded("compact", 7, true)).toBe(false);
  });

  test("최소 단계는 지표가 하나라도 있으면 접고 펼침 고정도 따르지 않는다", () => {
    expect(indicatorRowsFolded("minimal", 1, true)).toBe(true);
    expect(indicatorRowsFolded("minimal", 0, false)).toBe(false);
  });
});

describe("가격 패널 위 여백", () => {
  test("범례 아래 끝과 간격을 패널 높이로 나눈 값이다", () => {
    expect(priceTopMargin(114, 600)).toBeCloseTo(0.2);
  });

  test("범례가 작으면 하한, 너무 크면 상한으로 가둔다", () => {
    expect(priceTopMargin(0, 600)).toBeGreaterThanOrEqual(MIN_TOP_MARGIN);
    expect(priceTopMargin(900, 600)).toBe(MAX_TOP_MARGIN);
  });

  test("패널 높이를 모르면 하한이다", () => {
    expect(priceTopMargin(100, 0)).toBe(MIN_TOP_MARGIN);
  });
});
