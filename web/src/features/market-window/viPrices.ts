import type { BarsPage } from "../../api/generated/BarsPage";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { ViState } from "../../api/generated/ViState";
import { type TickRule, tickSize } from "./tick";

export interface ViPrices {
  readonly up: number;
  readonly down: number;
}

export function viPricesOf(base: number, rule: TickRule): ViPrices {
  const upTick = tickSize((base * 11) / 10, rule);
  const downTick = tickSize((base * 9) / 10, rule);
  const upStep = upTick * 10;
  const downStep = downTick * 10;
  return {
    up: Math.floor((base * 11 + upStep - 1) / upStep) * upTick,
    down: Math.floor((base * 9) / downStep) * downTick,
  };
}

export type ViBaseSource =
  | { readonly kind: "known"; readonly price: number }
  | { readonly kind: "dayOpen" }
  | { readonly kind: "releaseMinute"; readonly releasedAt: UnixSeconds }
  | { readonly kind: "unknown" };

export function viBaseSource(vi: ViState | null, known: boolean): ViBaseSource {
  if (!known) return { kind: "unknown" };
  if (vi !== null && vi.base !== null && vi.base > 0) return { kind: "known", price: vi.base };
  if (vi === null || vi.triggeredAt === null) return { kind: "dayOpen" };
  if (vi.active) return { kind: "unknown" };
  if (vi.releasedAt !== null) return { kind: "releaseMinute", releasedAt: vi.releasedAt };
  return { kind: "unknown" };
}

export function releaseMinuteOpen(page: Pick<BarsPage, "bars" | "current">, releasedAt: UnixSeconds): number | null {
  const minute = Math.floor(releasedAt / 60) * 60;
  let found: { readonly t: UnixSeconds; readonly o: number } | null = null;
  for (const bar of page.bars) {
    if (bar.t >= minute && (found === null || bar.t < found.t)) found = bar;
  }
  if (page.current !== null && page.current.t >= minute && (found === null || page.current.t < found.t)) {
    found = page.current;
  }
  return found !== null && found.o > 0 ? found.o : null;
}
