import { beforeEach, describe, expect, test } from "vitest";
import type { HeatmapFlowSeries } from "../api/generated/HeatmapFlowSeries";
import { withNotInThemesMissing } from "./flowMissing";
import { useServerModeStore } from "./serverMode";

const flow = (patch: Partial<HeatmapFlowSeries>): HeatmapFlowSeries => ({ date: "2026-11-09", bucketMinutes: 5, points: [], used: ["005930"], missing: ["000660"], overLimit: [], limit: 60, ...patch });

beforeEach(() => useServerModeStore.setState({ kind: "public" }));

describe("공개 모드 흐름의 테마 밖 종목", () => {
  test("빠진 종목에 합치고 중복은 한 번만 센다", () => {
    expect(withNotInThemesMissing(flow({ notInThemes: ["035420", "000660"] })).missing).toEqual(["000660", "035420"]);
  });

  test("테마 밖 종목이 없으면 그대로다", () => {
    const plain = flow({});
    expect(withNotInThemesMissing(plain)).toBe(plain);
    expect(withNotInThemesMissing(flow({ notInThemes: [] })).missing).toEqual(["000660"]);
  });

  test("로컬 모드는 바꾸지 않는다", () => {
    useServerModeStore.setState({ kind: "local" });
    const withField = flow({ notInThemes: ["035420"] });
    expect(withNotInThemesMissing(withField)).toBe(withField);
  });
});
