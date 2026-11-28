import type { TransferMode } from "./transfer";

export const BROKER_VIEWS = ["board", "list", "table", "transfer"] as const;
export type BrokerView = (typeof BROKER_VIEWS)[number];

export const BROKER_CARDS = ["bars", "both", "numbers"] as const;
export type BrokerCards = (typeof BROKER_CARDS)[number];

export const TRANSFER_RANGE_PRESETS = ["all", "last30", "last10", "peak"] as const;
export type TransferRangePreset = (typeof TRANSFER_RANGE_PRESETS)[number];

export interface BrokerPrefs {
  readonly transferMode: TransferMode;
  readonly transferShowOther: boolean;
  readonly transferRangePreset: TransferRangePreset;
  readonly transferDetailsOpen: boolean;
  readonly replayView: BrokerView;
  readonly replayCards: BrokerCards;
}

export const DEFAULT_BROKER_PREFS: BrokerPrefs = {
  transferMode: "net",
  transferShowOther: true,
  transferRangePreset: "all",
  transferDetailsOpen: false,
  replayView: "transfer",
  replayCards: "numbers",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isBrokerView = (value: unknown): value is BrokerView =>
  value === "board" || value === "list" || value === "table" || value === "transfer";

export const isBrokerCards = (value: unknown): value is BrokerCards =>
  value === "bars" || value === "both" || value === "numbers";

const isTransferMode = (value: unknown): value is TransferMode =>
  value === "net" || value === "gross";

const isTransferRangePreset = (value: unknown): value is TransferRangePreset =>
  value === "all" || value === "last30" || value === "last10" || value === "peak";

export function parseBrokerPrefs(raw: unknown): BrokerPrefs {
  if (!isRecord(raw)) return DEFAULT_BROKER_PREFS;
  const flag = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
  return {
    transferMode: isTransferMode(raw.transferMode) ? raw.transferMode : DEFAULT_BROKER_PREFS.transferMode,
    transferShowOther: flag(raw.transferShowOther, DEFAULT_BROKER_PREFS.transferShowOther),
    transferRangePreset: isTransferRangePreset(raw.transferRangePreset) ? raw.transferRangePreset : DEFAULT_BROKER_PREFS.transferRangePreset,
    transferDetailsOpen: flag(raw.transferDetailsOpen, DEFAULT_BROKER_PREFS.transferDetailsOpen),
    replayView: isBrokerView(raw.replayView) ? raw.replayView : DEFAULT_BROKER_PREFS.replayView,
    replayCards: isBrokerCards(raw.replayCards) ? raw.replayCards : DEFAULT_BROKER_PREFS.replayCards,
  };
}

export function mergeBrokerPrefs(current: BrokerPrefs, patch: Partial<BrokerPrefs>): BrokerPrefs {
  const next: BrokerPrefs = {
    transferMode: patch.transferMode ?? current.transferMode,
    transferShowOther: patch.transferShowOther ?? current.transferShowOther,
    transferRangePreset: patch.transferRangePreset ?? current.transferRangePreset,
    transferDetailsOpen: patch.transferDetailsOpen ?? current.transferDetailsOpen,
    replayView: patch.replayView ?? current.replayView,
    replayCards: patch.replayCards ?? current.replayCards,
  };
  if (
    next.transferMode === current.transferMode &&
    next.transferShowOther === current.transferShowOther &&
    next.transferRangePreset === current.transferRangePreset &&
    next.transferDetailsOpen === current.transferDetailsOpen &&
    next.replayView === current.replayView &&
    next.replayCards === current.replayCards
  ) {
    return current;
  }
  return next;
}
