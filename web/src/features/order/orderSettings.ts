export const SHARE_PRESET_COUNT = 4;
export const MAX_PRESET_SHARES = 999_999;

export interface OrderSettings {
  readonly sharePresets: readonly number[];
  readonly averageDot: boolean;
  readonly divider: boolean;
  readonly rate: boolean;
}

export const DEFAULT_ORDER_SETTINGS: OrderSettings = { sharePresets: [10, 50, 100, 500], averageDot: true, divider: true, rate: true };

const isPreset = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x > 0 && x <= MAX_PRESET_SHARES;

export function parseOrderSettings(raw: unknown): OrderSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_ORDER_SETTINGS;
  const { sharePresets, averageDot, divider, rate } = raw as Record<string, unknown>;
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  return {
    sharePresets: Array.isArray(sharePresets) && sharePresets.length === SHARE_PRESET_COUNT && sharePresets.every(isPreset) ? sharePresets : DEFAULT_ORDER_SETTINGS.sharePresets,
    averageDot: flag(averageDot, DEFAULT_ORDER_SETTINGS.averageDot),
    divider: flag(divider, DEFAULT_ORDER_SETTINGS.divider),
    rate: flag(rate, DEFAULT_ORDER_SETTINGS.rate),
  };
}

export function withPreset(settings: OrderSettings, index: number, text: string): OrderSettings {
  const value = Number(text);
  if (!isPreset(value) || index < 0 || index >= SHARE_PRESET_COUNT) return settings;
  return { ...settings, sharePresets: settings.sharePresets.map((preset, at) => (at === index ? value : preset)) };
}
