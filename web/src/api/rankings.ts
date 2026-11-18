import type { Ranking } from "./generated/Ranking";
import type { RankingPage } from "./generated/RankingPage";
import type { RankingRequest } from "./generated/RankingRequest";
import type { RankingTrigger } from "./generated/RankingTrigger";
import { sendJson } from "./http";

export const fetchRanking = (ranking: Ranking, pages: number, trigger: RankingTrigger) =>
  sendJson<RankingPage>("POST", "/api/rankings", JSON.stringify({ ranking, pages, trigger } satisfies RankingRequest));
