import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_UI_PREFS, parseUiState, toUiState } from "../../persist/uiState";
import { useUiStore } from "../../stores/ui";
import { DEFAULT_BROKER_PREFS, mergeBrokerPrefs, parseBrokerPrefs, type BrokerPrefs } from "./prefs";

afterEach(() => vi.restoreAllMocks());

describe("거래원 분석 옵션 영속화", () => {
  test("유효한 거래원 옵션을 그대로 복원하고 UiState로 왕복한다", () => {
    const custom: BrokerPrefs = {
      transferMode: "gross",
      transferShowOther: false,
      transferRangePreset: "last10",
      transferDetailsOpen: true,
      replayView: "board",
      replayCards: "both",
    };
    expect(parseBrokerPrefs(custom)).toEqual(custom);
    const { prefs, extra } = parseUiState({ lastLayoutId: null, theme: "dark", brokers: custom });
    expect(prefs.brokers).toEqual(custom);
    expect(extra).toEqual({});
    expect(parseUiState(toUiState(prefs, extra)).prefs.brokers).toEqual(custom);
  });

  test("예전 저장 데이터에 남은 transferLevel과 chartSync 키는 경고 없이 무시하고 다시 저장하지 않는다", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const legacy = {
      transferLevel: "group",
      transferMode: "gross",
      transferShowOther: false,
      transferRangePreset: "last10",
      transferDetailsOpen: true,
      chartSync: true,
      replayView: "board",
      replayCards: "both",
    };
    const expected: BrokerPrefs = {
      transferMode: "gross",
      transferShowOther: false,
      transferRangePreset: "last10",
      transferDetailsOpen: true,
      replayView: "board",
      replayCards: "both",
    };
    expect(parseBrokerPrefs(legacy)).toEqual(expected);
    const { prefs, extra } = parseUiState({ lastLayoutId: null, theme: "dark", brokers: legacy });
    expect(prefs.brokers).toEqual(expected);
    expect(extra).toEqual({});
    const saved = toUiState(prefs, extra);
    expect(saved.brokers).toEqual(expected);
    expect(saved.brokers).not.toHaveProperty("transferLevel");
    expect(saved.brokers).not.toHaveProperty("chartSync");
    expect(warn).not.toHaveBeenCalled();
  });

  test("없거나 잘못된 필드는 해당 항목만 기본값으로 채운다", () => {
    expect(parseBrokerPrefs(undefined)).toEqual(DEFAULT_BROKER_PREFS);
    expect(parseBrokerPrefs(null)).toEqual(DEFAULT_BROKER_PREFS);
    expect(parseBrokerPrefs([])).toEqual(DEFAULT_BROKER_PREFS);
    expect(
      parseBrokerPrefs({
        transferLevel: "unknown",
        transferMode: "gross",
        transferShowOther: "no",
        transferRangePreset: "peak",
        transferDetailsOpen: 1,
        chartSync: true,
        replayView: "invalid",
        replayCards: "bars",
      }),
    ).toEqual({
      transferMode: "gross",
      transferShowOther: true,
      transferRangePreset: "peak",
      transferDetailsOpen: false,
      replayView: "transfer",
      replayCards: "bars",
    });
  });

  test("mergeBrokerPrefs는 값이 바뀌지 않으면 같은 참조를 돌려준다", () => {
    expect(mergeBrokerPrefs(DEFAULT_BROKER_PREFS, {})).toBe(DEFAULT_BROKER_PREFS);
    expect(
      mergeBrokerPrefs(DEFAULT_BROKER_PREFS, {
        transferMode: "net",
        transferShowOther: true,
      }),
    ).toBe(DEFAULT_BROKER_PREFS);
    const updated = mergeBrokerPrefs(DEFAULT_BROKER_PREFS, {
      transferMode: "gross",
      transferRangePreset: "last30",
    });
    expect(updated).toEqual({
      ...DEFAULT_BROKER_PREFS,
      transferMode: "gross",
      transferRangePreset: "last30",
    });
  });

  test("useUiStore.setBrokerPrefs는 실제 변경 시에만 revision을 올린다", () => {
    useUiStore.getState().load(DEFAULT_UI_PREFS, {});
    const before = useUiStore.getState().revision;
    useUiStore.getState().setBrokerPrefs({ transferMode: "net" });
    expect(useUiStore.getState().revision).toBe(before);

    useUiStore.getState().setBrokerPrefs({
      transferMode: "gross",
      transferShowOther: false,
      transferRangePreset: "peak",
      transferDetailsOpen: true,
      replayView: "list",
      replayCards: "bars",
    });
    expect(useUiStore.getState().revision).toBe(before + 1);
    expect(useUiStore.getState().prefs.brokers).toEqual({
      transferMode: "gross",
      transferShowOther: false,
      transferRangePreset: "peak",
      transferDetailsOpen: true,
      replayView: "list",
      replayCards: "bars",
    });

    useUiStore.getState().setBrokerPrefs({ transferRangePreset: "peak" });
    expect(useUiStore.getState().revision).toBe(before + 1);
  });
});
