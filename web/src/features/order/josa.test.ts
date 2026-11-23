import { describe, expect, it } from "vitest";
import { withDirectionJosa } from "./josa";

describe("withDirectionJosa", () => {
  it("받침 없이 읽히는 끝자리와 ㄹ 받침 끝자리는 로를 쓴다", () => {
    expect([1, 2, 4, 5, 7, 8, 9, 42, 1_007].map(withDirectionJosa)).toEqual(["1로", "2로", "4로", "5로", "7로", "8로", "9로", "42로", "1,007로"]);
  });

  it("받침으로 읽히는 끝자리와 0으로 끝나는 수는 으로를 쓴다", () => {
    expect([3, 6, 10, 100, 1_000, 10_000].map(withDirectionJosa)).toEqual(["3으로", "6으로", "10으로", "100으로", "1,000으로", "10,000으로"]);
  });
});
