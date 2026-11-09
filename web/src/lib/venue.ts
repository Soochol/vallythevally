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

/**
 * 칸이 지금 그리는 거래소. 저장하지 않는 파생값이다. 저장 원본(`CellState.venue`, 사용자가 고른 것)과 섞이지 않게 타입을 나눈다.
 * 차트와 거래소 표시는 이 타입만 받는다.
 */
export type ShownVenue = Venue & { readonly __shown: true };

/**
 * 저장된 거래소를 종목 정보로 확인해 그릴 거래소를 정한다(ADR 0007).
 * 종목 정보가 없으면(받는 중, 일시 실패) NXT 허용을 모르므로 NXT만 통합으로 그린다. 저장된 값은 바꾸지 않는다.
 */
export function shownVenue(saved: Venue | null, info: VenueTarget | undefined): ShownVenue | null {
  if (saved === null) return null;
  const venue = info === undefined ? (saved === "nxt" ? "combined" : saved) : venueFor(info, saved);
  return venue as ShownVenue | null;
}

export const venueLabel = (code: SymbolCode, venue: Venue | null) => (isIndexCode(code) || venue === null ? "" : VENUE_LABEL[venue]);
