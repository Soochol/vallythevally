import type { MarketOverviewBreadth } from "../../api/generated/MarketOverviewBreadth";
import { formatCount } from "./marketFormat";

export const MISSING_COUNT = "-";

export const formatOptionalCount = (count: number | null): string => (count === null ? MISSING_COUNT : formatCount(count));

export interface BreadthShares {
  up: number;
  flat: number;
  down: number;
}

export function breadthShares({ rising, flat, falling }: MarketOverviewBreadth): BreadthShares | null {
  if (rising === null && flat === null && falling === null) return null;
  const total = Math.max((rising ?? 0) + (flat ?? 0) + (falling ?? 0), 1);
  const share = (count: number | null) => ((count ?? 0) / total) * 100;
  return { up: share(rising), flat: share(flat), down: share(falling) };
}
