import { describe, expect, it } from "vitest";
import { ageLabel, assessDataAge } from "./dataAge";

const NOW = 1_794_186_000;

describe("assessDataAge", () => {
  it("주기의 두 배까지는 나이를 보이지 않는다", () => {
    expect(assessDataAge(NOW - 20, NOW, "ranking", true).label).toBeNull();
    expect(assessDataAge(NOW - 21, NOW, "ranking", true).label).toBe("21초 전 자료");
    expect(assessDataAge(NOW - 60, NOW, "heatmapBoard", false).label).toBeNull();
    expect(assessDataAge(NOW - 61, NOW, "heatmapBoard", false).label).toBe("1분 전 자료");
    expect(assessDataAge(NOW - 120, NOW, "heatmapFlow", false).label).toBeNull();
    expect(assessDataAge(NOW - 121, NOW, "marketOverview", false).label).toBe("2분 전 자료");
    expect(assessDataAge(NOW - 61, NOW, "screener", false).label).toBe("1분 전 자료");
  });

  it("장중에 5분을 넘어야 낡음이다", () => {
    expect(assessDataAge(NOW - 300, NOW, "ranking", true)).toEqual({ label: "5분 전 자료", stale: false });
    expect(assessDataAge(NOW - 301, NOW, "ranking", true)).toEqual({ label: "5분 전 자료", stale: true });
  });

  it("장 밖에는 오래돼도 낡음 표시 없이 나이만 보인다", () => {
    expect(assessDataAge(NOW - 3600, NOW, "ranking", false)).toEqual({ label: "1시간 전 자료", stale: false });
  });

  it("기준 시각이 없으면 아무것도 보이지 않고 미래 시각은 나이 0이다", () => {
    expect(assessDataAge(null, NOW, "ranking", true)).toEqual({ label: null, stale: false });
    expect(assessDataAge(NOW + 500, NOW, "ranking", true)).toEqual({ label: null, stale: false });
  });
});

describe("ageLabel", () => {
  it("초·분·시간·일로 줄인다", () => {
    expect(ageLabel(59.9)).toBe("59초 전 자료");
    expect(ageLabel(60)).toBe("1분 전 자료");
    expect(ageLabel(3599)).toBe("59분 전 자료");
    expect(ageLabel(3600)).toBe("1시간 전 자료");
    expect(ageLabel(86_400)).toBe("1일 전 자료");
  });
});
