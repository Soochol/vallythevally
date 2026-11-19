import { describe, expect, it } from "vitest";
import { formatEok, signedEok, signedRate } from "./marketFormat";

describe("marketFormat", () => {
  it("1만억 이상은 조로 묶는다", () => {
    expect(formatEok(12_345)).toBe("1.2조");
    expect(formatEok(9_876)).toBe("9,876억");
    expect(formatEok(-15_000)).toBe("−1.5조");
  });
  it("부호를 붙인다", () => {
    expect(signedEok(320)).toBe("+320억");
    expect(signedEok(-45)).toBe("−45억");
    expect(signedRate(-0.67)).toBe("−0.67%");
    expect(signedRate(1.2)).toBe("+1.20%");
  });
});
