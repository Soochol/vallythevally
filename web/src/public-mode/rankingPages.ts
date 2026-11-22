import type { RankingPage } from "../api/generated/RankingPage";
import { isPublicMode } from "./serverMode";

export const PUBLIC_RANKING_MAX_PAGES = 5;

export function capRankingPage(page: RankingPage): RankingPage {
  if (!isPublicMode() || page.end || page.limited || page.pages < PUBLIC_RANKING_MAX_PAGES) return page;
  return { ...page, limited: true };
}
