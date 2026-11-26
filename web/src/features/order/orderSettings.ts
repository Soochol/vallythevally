import type { Venue } from "../../api/generated/Venue";
import { isVenue } from "../../lib/venue";

export const AMOUNT_PRESET_COUNT = 4;
export const MAX_PRESET_AMOUNT_MAN = 999_999;
export const AMOUNT_UNIT_WON = 10_000;
export const ORDER_ROUTES = [{ value: "combined", label: "SOR" }, { value: "krx", label: "KRX" }, { value: "nxt", label: "NXT" }] as const;
export const routeLabel = (venue: Venue): string => ORDER_ROUTES.find((route) => route.value === venue)!.label;
export const PRESET_MODES = [{ value: "amount", label: "금액" }, { value: "buy", label: "매수" }, { value: "sell", label: "매도" }] as const;
export type PresetMode = (typeof PRESET_MODES)[number]["value"];
const isPresetMode = (value: unknown): value is PresetMode => value === "amount" || value === "buy" || value === "sell";
export const LADDER_DENSITIES = [{ value: "compact", label: "촘촘" }, { value: "normal", label: "보통" }, { value: "spacious", label: "여유" }] as const;
export type LadderDensity = (typeof LADDER_DENSITIES)[number]["value"];
const isLadderDensity = (value: unknown): value is LadderDensity => value === "compact" || value === "normal" || value === "spacious";
export const LADDER_DENSITY_LABEL = "호가 간격";
export const LADDER_ROW_HEIGHT_BY_DENSITY: Readonly<Record<LadderDensity, number>> = { compact: 20, normal: 24, spacious: 30 };
export const ladderRowHeightPx = (density: LadderDensity): number => LADDER_ROW_HEIGHT_BY_DENSITY[density];
export const KEEP_LAST_ENTRY_LABEL = "마지막 주문 수량 유지";
export const ORDER_SOUND_LABEL = "주문 소리";

export interface OrderSettings {
  readonly amountPresets: readonly number[];
  readonly presetMode: PresetMode;
  readonly ladderDensity: LadderDensity;
  readonly averageDot: boolean;
  readonly divider: boolean;
  readonly rate: boolean;
  readonly skipSpreadGap: boolean;
  readonly maskAccount: boolean;
  readonly keepLastEntry: boolean;
  readonly sound: boolean;
  readonly venue: Venue;
  readonly account: string | null;
}

export const DEFAULT_ORDER_SETTINGS: OrderSettings = { amountPresets: [100, 500, 1_000, 5_000], presetMode: "amount", ladderDensity: "normal", averageDot: true, divider: true, rate: true, skipSpreadGap: false, maskAccount: true, keepLastEntry: true, sound: true, venue: "combined", account: null };

const isPreset = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x > 0 && x <= MAX_PRESET_AMOUNT_MAN;

export function parseOrderSettings(raw: unknown): OrderSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_ORDER_SETTINGS;
  const { amountPresets, presetMode, ladderDensity, averageDot, divider, rate, skipSpreadGap, maskAccount, keepLastEntry, sound, venue, account } = raw as Record<string, unknown>;
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  return {
    amountPresets: Array.isArray(amountPresets) && amountPresets.length === AMOUNT_PRESET_COUNT && amountPresets.every(isPreset) ? amountPresets : DEFAULT_ORDER_SETTINGS.amountPresets,
    presetMode: isPresetMode(presetMode) ? presetMode : DEFAULT_ORDER_SETTINGS.presetMode,
    ladderDensity: isLadderDensity(ladderDensity) ? ladderDensity : DEFAULT_ORDER_SETTINGS.ladderDensity,
    averageDot: flag(averageDot, DEFAULT_ORDER_SETTINGS.averageDot),
    divider: flag(divider, DEFAULT_ORDER_SETTINGS.divider),
    rate: flag(rate, DEFAULT_ORDER_SETTINGS.rate),
    skipSpreadGap: flag(skipSpreadGap, DEFAULT_ORDER_SETTINGS.skipSpreadGap),
    maskAccount: flag(maskAccount, DEFAULT_ORDER_SETTINGS.maskAccount),
    keepLastEntry: flag(keepLastEntry, DEFAULT_ORDER_SETTINGS.keepLastEntry),
    sound: flag(sound, DEFAULT_ORDER_SETTINGS.sound),
    venue: typeof venue === "string" && isVenue(venue) ? venue : DEFAULT_ORDER_SETTINGS.venue,
    account: typeof account === "string" && account !== "" ? account : null,
  };
}

export function withAmountPreset(settings: OrderSettings, index: number, text: string): OrderSettings {
  const value = Number(text);
  if (text.trim() === "" || !isPreset(value) || index < 0 || index >= AMOUNT_PRESET_COUNT) return settings;
  return { ...settings, amountPresets: settings.amountPresets.map((preset, at) => (at === index ? value : preset)) };
}
