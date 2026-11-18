import type { Venue } from "../../api/generated/Venue";
import { isVenue } from "../../lib/venue";

export const SHARE_PRESET_COUNT = 4;
export const MAX_PRESET_SHARES = 999_999;
export const MAX_PRESET_AMOUNT_MAN = 999_999;
export const AMOUNT_UNIT_WON = 10_000;

export interface OrderSettings {
  readonly sharePresets: readonly number[];
  readonly amountPresets: readonly number[];
  readonly averageDot: boolean;
  readonly divider: boolean;
  readonly rate: boolean;
  readonly venue: Venue;
}

export const DEFAULT_ORDER_SETTINGS: OrderSettings = { sharePresets: [10, 50, 100, 500], amountPresets: [100, 500, 1_000, 5_000], averageDot: true, divider: true, rate: true, venue: "combined" };

const isPreset = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x > 0 && x <= MAX_PRESET_SHARES;

export function parseOrderSettings(raw: unknown): OrderSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_ORDER_SETTINGS;
  const { sharePresets, amountPresets, averageDot, divider, rate, venue } = raw as Record<string, unknown>;
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  return {
    sharePresets: Array.isArray(sharePresets) && sharePresets.length === SHARE_PRESET_COUNT && sharePresets.every(isPreset) ? sharePresets : DEFAULT_ORDER_SETTINGS.sharePresets,
    amountPresets: Array.isArray(amountPresets) && amountPresets.length === SHARE_PRESET_COUNT && amountPresets.every(isPreset) ? amountPresets : DEFAULT_ORDER_SETTINGS.amountPresets,
    averageDot: flag(averageDot, DEFAULT_ORDER_SETTINGS.averageDot),
    divider: flag(divider, DEFAULT_ORDER_SETTINGS.divider),
    rate: flag(rate, DEFAULT_ORDER_SETTINGS.rate),
    venue: typeof venue === "string" && isVenue(venue) ? venue : DEFAULT_ORDER_SETTINGS.venue,
  };
}

export type PresetKind = "sharePresets" | "amountPresets";

export function withPresetOf(settings: OrderSettings, kind: PresetKind, index: number, text: string): OrderSettings {
  const value = Number(text);
  if (text.trim() === "" || !isPreset(value) || index < 0 || index >= SHARE_PRESET_COUNT) return settings;
  return { ...settings, [kind]: settings[kind].map((preset, at) => (at === index ? value : preset)) };
}

export const withPreset = (settings: OrderSettings, index: number, text: string): OrderSettings => withPresetOf(settings, "sharePresets", index, text);
