import type { SymbolCode } from "../api/generated/SymbolCode";
import type { SymbolInfo } from "../api/generated/SymbolInfo";
import type { Venue } from "../api/generated/Venue";
import { isIndexCode } from "./symbol";

export const VENUES = ["combined", "krx", "nxt"] as const satisfies readonly Venue[];
export const VENUE_LABEL: Record<Venue, string> = { combined: "통합", krx: "KRX", nxt: "NXT" };
export const NXT_UNAVAILABLE = "NXT에서 거래되지 않는 종목";

export const isVenue = (x: string): x is Venue => (VENUES as readonly string[]).includes(x);

/** 칸에 종목을 열 때 필요한 것. 주소에서 종목 정보를 받지 못하면 nxtEnabled를 모르므로 false로 둔다. */
export type VenueTarget = Pick<SymbolInfo, "code" | "nxtEnabled">;

export function isVenueAllowed(target: VenueTarget, venue: Venue): boolean {
  return !isIndexCode(target.code) && (venue !== "nxt" || target.nxtEnabled);
}

/**
 * 종목을 열 때 칸의 거래소(ADR 0007). 지수는 null.
 * 주식은 바라는 거래소가 허용되면 그것을, 아니면(지수에서 왔거나 NXT 불가) 통합을 쓴다.
 */
export function venueFor(target: VenueTarget, wanted: Venue | null): Venue | null {
  if (isIndexCode(target.code)) return null;
  return wanted !== null && isVenueAllowed(target, wanted) ? wanted : "combined";
}

export const venueLabel = (code: SymbolCode, venue: Venue | null) => (isIndexCode(code) || venue === null ? "" : VENUE_LABEL[venue]);
