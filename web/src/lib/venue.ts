import type { SymbolCode } from "../api/generated/SymbolCode";
import type { SymbolInfo } from "../api/generated/SymbolInfo";
import type { Venue } from "../api/generated/Venue";
import { isIndexCode } from "./symbol";

export const VENUES = ["combined", "krx", "nxt"] as const satisfies readonly Venue[];
export const VENUE_LABEL: Record<Venue, string> = { combined: "통합", krx: "KRX", nxt: "NXT" };
export const NXT_UNAVAILABLE = "NXT에서 거래되지 않는 종목";

export const isVenue = (x: string): x is Venue => (VENUES as readonly string[]).includes(x);

/** 칸이 보이는 거래소를 정할 때 필요한 종목 정보. */
export type VenueTarget = Pick<SymbolInfo, "code" | "nxtEnabled">;

export type ShownVenue = Venue & { readonly __shown: true };

/**
 * 칸이 보이는 거래소(ADR 0020). 지수는 null.
 * 앱 전체 거래소가 NXT인데 종목이 NXT에서 거래되지 않으면 통합이다. 종목 정보가 없으면(받는 중·실패) NXT만 통합으로 본다.
 */
export function shownVenue(code: SymbolCode, appVenue: Venue, info: VenueTarget | undefined): ShownVenue | null {
  if (isIndexCode(code)) return null;
  const venue = appVenue === "nxt" && !(info?.nxtEnabled ?? false) ? "combined" : appVenue;
  return venue as ShownVenue;
}

export const venueLabel = (code: SymbolCode, venue: Venue | null) => (isIndexCode(code) || venue === null ? "" : VENUE_LABEL[venue]);
