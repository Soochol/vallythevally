import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { useSymbolInfo } from "../../api/queries";
import { shownVenue } from "../../lib/venue";
import { useVenue } from "../../stores/ui";

export function useShownVenue(code: SymbolCode): Venue {
  const appVenue = useVenue();
  return shownVenue(code, appVenue, useSymbolInfo(code).data) ?? "combined";
}
