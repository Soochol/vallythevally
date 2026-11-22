import { beforeEach, describe, expect, test } from "vitest";
import type { RankingPage } from "../api/generated/RankingPage";
import { capRankingPage, PUBLIC_RANKING_MAX_PAGES } from "./rankingPages";
import { useServerModeStore } from "./serverMode";

const page = (pages: number, patch: Partial<RankingPage> = {}): RankingPage => ({ rows: [], pages, end: false, limited: false, hidden: 0, fetchedAt: 0, ...patch });

beforeEach(() => useServerModeStore.setState({ kind: "public" }));

describe("공개 모드 순위 쪽 수", () => {
  test("5쪽을 받으면 더 받지 않도록 막는다", () => {
    expect(capRankingPage(page(PUBLIC_RANKING_MAX_PAGES)).limited).toBe(true);
    expect(capRankingPage(page(PUBLIC_RANKING_MAX_PAGES - 1)).limited).toBe(false);
  });

  test("이미 끝난 순위는 그대로다", () => {
    const done = page(PUBLIC_RANKING_MAX_PAGES, { end: true });
    expect(capRankingPage(done)).toBe(done);
  });

  test("로컬 모드는 바꾸지 않는다", () => {
    useServerModeStore.setState({ kind: "local" });
    const full = page(PUBLIC_RANKING_MAX_PAGES);
    expect(capRankingPage(full)).toBe(full);
  });
});
