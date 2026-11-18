import type { Ranking } from "../api/generated/Ranking";
import type { Venue } from "../api/generated/Venue";

export const defaultRanking = (venue: Venue): Ranking => ({
  kind: "tradeAmount",
  market: "all",
  venue,
  excludes: { etfEtn: true, preferred: false },
  excludeManaged: false,
});
