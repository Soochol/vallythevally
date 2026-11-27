import { describe, expect, it } from "vitest";
import { marketSessionLabel } from "./TopbarClock";

const kst = (iso: string): number => Math.floor(Date.parse(`${iso}+09:00`) / 1000);

describe("marketSessionLabel", () => {
  it("classifies weekday KST session windows", () => {
    expect(marketSessionLabel(kst("2026-11-27T07:59:59"))).toBe("장마감");
    expect(marketSessionLabel(kst("2026-11-27T08:00:00"))).toBe("장전");
    expect(marketSessionLabel(kst("2026-11-27T08:49:59"))).toBe("장전");
    expect(marketSessionLabel(kst("2026-11-27T08:50:00"))).toBe("장전동시");
    expect(marketSessionLabel(kst("2026-11-27T08:59:59"))).toBe("장전동시");
    expect(marketSessionLabel(kst("2026-11-27T09:00:00"))).toBe("정규장");
    expect(marketSessionLabel(kst("2026-11-27T15:19:59"))).toBe("정규장");
    expect(marketSessionLabel(kst("2026-11-27T15:20:00"))).toBe("장후동시");
    expect(marketSessionLabel(kst("2026-11-27T15:29:59"))).toBe("장후동시");
    expect(marketSessionLabel(kst("2026-11-27T15:30:00"))).toBe("NXT 애프터");
    expect(marketSessionLabel(kst("2026-11-27T19:59:59"))).toBe("NXT 애프터");
    expect(marketSessionLabel(kst("2026-11-27T20:00:00"))).toBe("장마감");
  });

  it("treats weekends as closed", () => {
    expect(marketSessionLabel(kst("2026-11-28T10:00:00"))).toBe("장마감");
    expect(marketSessionLabel(kst("2026-11-29T14:00:00"))).toBe("장마감");
  });
});
