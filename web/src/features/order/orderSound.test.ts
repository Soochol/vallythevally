import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { TradingExecutions } from "../../api/generated/TradingExecutions";
import { DEFAULT_UI_PREFS } from "../../persist/uiState";
import { useUiStore } from "../../stores/ui";
import {
  createExecutionTracker,
  createOrderSoundPlayer,
  executionTotalsOf,
  observeOrderExecutions,
  ORDER_SOUND_TONES,
  playOrderSound,
  primeOrderSound,
} from "./orderSound";

interface FakeOscillatorRecord {
  type: OscillatorType;
  readonly frequencies: { readonly value: number; readonly at: number }[];
  startAt: number | null;
  stopAt: number | null;
  disconnected: boolean;
  triggerEnd(): void;
}

interface FakeGainRecord {
  disconnected: boolean;
}

interface FakeAudioEnv {
  readonly context: AudioContext;
  readonly oscillators: FakeOscillatorRecord[];
  readonly gains: FakeGainRecord[];
  resumeCalls: number;
  state: AudioContextState;
  currentTime: number;
}

function createFakeAudioEnv(initialState: AudioContextState = "running", initialTime = 1): FakeAudioEnv {
  const oscillators: FakeOscillatorRecord[] = [];
  const gains: FakeGainRecord[] = [];
  const env: FakeAudioEnv = {
    context: null as unknown as AudioContext,
    oscillators,
    gains,
    resumeCalls: 0,
    state: initialState,
    currentTime: initialTime,
  };
  const destination = {} as AudioDestinationNode;
  const ctx = {
    get state() {
      return env.state;
    },
    get currentTime() {
      return env.currentTime;
    },
    destination,
    resume() {
      env.resumeCalls += 1;
      env.state = "running";
      return Promise.resolve();
    },
    createOscillator() {
      let ended: (() => void) | null = null;
      const record: FakeOscillatorRecord = {
        type: "sine",
        frequencies: [],
        startAt: null,
        stopAt: null,
        disconnected: false,
        triggerEnd() {
          ended?.();
        },
      };
      oscillators.push(record);
      return {
        get type() {
          return record.type;
        },
        set type(value: OscillatorType) {
          record.type = value;
        },
        frequency: {
          setValueAtTime(value: number, at: number) {
            record.frequencies.push({ value, at });
          },
        },
        set onended(handler: (() => void) | null) {
          ended = handler;
        },
        connect() {
          return undefined;
        },
        disconnect() {
          record.disconnected = true;
        },
        start(when = 0) {
          record.startAt = when;
        },
        stop(when = 0) {
          record.stopAt = when;
        },
      };
    },
    createGain() {
      const record: FakeGainRecord = { disconnected: false };
      gains.push(record);
      return {
        gain: {
          setValueAtTime() {
            return undefined;
          },
          linearRampToValueAtTime() {
            return undefined;
          },
          exponentialRampToValueAtTime() {
            return undefined;
          },
        },
        connect() {
          return undefined;
        },
        disconnect() {
          record.disconnected = true;
        },
      };
    },
  };
  (env as { context: AudioContext }).context = ctx as unknown as AudioContext;
  return env;
}

const fill = (orderNo: string, quantity: number, side: "buy" | "sell" = "buy", time = "093000"): TradingExecution => ({
  orderNo,
  code: "005930",
  name: "삼성전자",
  side,
  quantity,
  price: 70_000,
  time,
  venue: "krx",
});

const snapshot = (executions: TradingExecution[], accountRef = "acct-a", day = "2026-11-18"): TradingExecutions => ({
  accountRef,
  day,
  executions,
});

describe("체결 증가 추적", () => {
  it("같은 주문번호의 수량을 합산한다", () => {
    const totals = executionTotalsOf([fill("1", 3), fill("2", 5), fill("1", 4)]);
    expect(totals.get("1")).toBe(7);
    expect(totals.get("2")).toBe(5);
  });

  it("초기 스냅샷은 빈 목록이든 체결이 있든 기준선으로만 삼고 울리지 않는다", () => {
    const emptyTracker = createExecutionTracker();
    expect(emptyTracker.observe(snapshot([]))).toBe(false);

    const populatedTracker = createExecutionTracker();
    expect(populatedTracker.observe(snapshot([fill("1", 5)]))).toBe(false);
  });

  it("새 체결이 추가되면 true이고 같은 목록이 반복되면 false다", () => {
    const tracker = createExecutionTracker();
    expect(tracker.observe(snapshot([fill("1", 5)]))).toBe(false);
    expect(tracker.observe(snapshot([fill("1", 5), fill("2", 3)]))).toBe(true);
    expect(tracker.observe(snapshot([fill("1", 5), fill("2", 3)]))).toBe(false);
  });

  it("키움 방식의 같은 주문번호 행 추가와 한투 방식의 수량 증가를 모두 체결로 본다", () => {
    const kiwoom = createExecutionTracker();
    expect(kiwoom.observe(snapshot([fill("1", 5, "buy", "093000")]))).toBe(false);
    expect(kiwoom.observe(snapshot([fill("1", 5, "buy", "093000"), fill("1", 4, "buy", "093005")]))).toBe(true);
    expect(kiwoom.observe(snapshot([fill("1", 5, "buy", "093000"), fill("1", 4, "buy", "093005")]))).toBe(false);

    const kis = createExecutionTracker();
    expect(kis.observe(snapshot([fill("1", 5)]))).toBe(false);
    expect(kis.observe(snapshot([fill("1", 9)]))).toBe(true);
    expect(kis.observe(snapshot([fill("1", 9)]))).toBe(false);
  });

  it("계좌별 기준선이 독립이고 날짜가 바뀌면 기준선을 다시 잡는다", () => {
    const tracker = createExecutionTracker();
    expect(tracker.observe(snapshot([fill("1", 5)], "acct-a", "2026-11-18"))).toBe(false);
    expect(tracker.observe(snapshot([fill("9", 10)], "acct-b", "2026-11-18"))).toBe(false);
    expect(tracker.observe(snapshot([fill("1", 5), fill("2", 1)], "acct-a", "2026-11-18"))).toBe(true);
    expect(tracker.observe(snapshot([fill("9", 10)], "acct-b", "2026-11-18"))).toBe(false);

    expect(tracker.observe(snapshot([fill("10", 2)], "acct-a", "2026-11-19"))).toBe(false);
    expect(tracker.observe(snapshot([fill("10", 2), fill("11", 1)], "acct-a", "2026-11-19"))).toBe(true);
  });
});

describe("주문 소리 재생기", () => {
  it("매수 접수·매도 접수·체결에 서로 다른 주파수와 파형을 예약하고 종료 시 연결을 끊는다", () => {
    const env = createFakeAudioEnv("running", 2);
    const player = createOrderSoundPlayer(() => env.context);

    player.play("buy-accepted");
    const buyOscs = env.oscillators.slice();
    expect(buyOscs.map((o) => o.frequencies[0]?.value)).toEqual(ORDER_SOUND_TONES["buy-accepted"].map((s) => s.frequency));
    expect(buyOscs.map((o) => o.type)).toEqual(ORDER_SOUND_TONES["buy-accepted"].map((s) => s.type));

    const sellStartIndex = env.oscillators.length;
    player.play("sell-accepted");
    const sellOscs = env.oscillators.slice(sellStartIndex);
    expect(sellOscs.map((o) => o.frequencies[0]?.value)).toEqual(ORDER_SOUND_TONES["sell-accepted"].map((s) => s.frequency));
    expect(sellOscs.map((o) => o.type)).toEqual(ORDER_SOUND_TONES["sell-accepted"].map((s) => s.type));
    expect(buyOscs.map((o) => o.frequencies[0]?.value)).not.toEqual(sellOscs.map((o) => o.frequencies[0]?.value));

    const fillStartIndex = env.oscillators.length;
    player.play("filled");
    const fillOscs = env.oscillators.slice(fillStartIndex);
    expect(fillOscs.map((o) => o.frequencies[0]?.value)).toEqual(ORDER_SOUND_TONES.filled.map((s) => s.frequency));
    expect(fillOscs.map((o) => o.type)).toEqual(ORDER_SOUND_TONES.filled.map((s) => s.type));

    buyOscs[0]!.triggerEnd();
    expect(buyOscs[0]!.disconnected).toBe(true);
    expect(env.gains[0]!.disconnected).toBe(true);
  });

  it("suspended 상태면 prime과 play에서 resume을 호출하고 연속 재생 시 시작 시각을 띄운다", () => {
    const env = createFakeAudioEnv("suspended", 1);
    const player = createOrderSoundPlayer(() => env.context);

    player.prime();
    expect(env.resumeCalls).toBe(1);
    expect(env.oscillators).toHaveLength(0);

    env.state = "suspended";
    player.play("buy-accepted");
    expect(env.resumeCalls).toBe(2);
    const firstEnd = Math.max(...env.oscillators.map((o) => o.stopAt ?? 0));

    const secondOffset = env.oscillators.length;
    player.play("sell-accepted");
    const secondStart = env.oscillators[secondOffset]!.startAt!;
    expect(secondStart).toBeGreaterThanOrEqual(firstEnd + 0.025 - 1e-6);
  });

  it("닫힌 컨텍스트는 다시 만들고 컨텍스트 생성이 null이거나 실패해도 예외를 던지지 않는다", () => {
    const first = createFakeAudioEnv("running", 1);
    const second = createFakeAudioEnv("running", 1);
    const queue = [first, second];
    const player = createOrderSoundPlayer(() => queue.shift()?.context ?? null);

    player.play("buy-accepted");
    expect(first.oscillators).toHaveLength(ORDER_SOUND_TONES["buy-accepted"].length);

    first.state = "closed";
    player.play("sell-accepted");
    expect(second.oscillators).toHaveLength(ORDER_SOUND_TONES["sell-accepted"].length);

    const silent = createOrderSoundPlayer(() => null);
    expect(() => silent.prime()).not.toThrow();
    expect(() => silent.play("filled")).not.toThrow();

    const broken = createOrderSoundPlayer(() => {
      throw new Error("blocked");
    });
    expect(() => broken.prime()).not.toThrow();
    expect(() => broken.play("buy-accepted")).not.toThrow();
  });
});

describe("주문 소리 앱 설정 연동", () => {
  const created: FakeAudioEnv[] = [];

  afterEach(() => {
    for (const env of created) env.state = "closed";
    created.length = 0;
    vi.unstubAllGlobals();
    useUiStore.getState().load(DEFAULT_UI_PREFS, {});
  });

  const stubAudio = (initialState: AudioContextState = "running"): FakeAudioEnv => {
    const env = createFakeAudioEnv(initialState, 1);
    created.push(env);
    vi.stubGlobal("AudioContext", function AudioContextStub() {
      return env.context;
    });
    return env;
  };

  it("sound 설정이 켜져 있을 때만 재생·준비하고 끄면 울리지 않는다", () => {
    const env = stubAudio("suspended");
    useUiStore.getState().load({ ...DEFAULT_UI_PREFS, orderSettings: { ...DEFAULT_UI_PREFS.orderSettings, sound: false } }, {});

    primeOrderSound();
    playOrderSound("buy-accepted");
    expect(env.resumeCalls).toBe(0);
    expect(env.oscillators).toHaveLength(0);

    useUiStore.getState().setOrderSettings({ ...DEFAULT_UI_PREFS.orderSettings, sound: true });
    primeOrderSound();
    expect(env.resumeCalls).toBe(1);
    playOrderSound("buy-accepted");
    expect(env.oscillators).toHaveLength(ORDER_SOUND_TONES["buy-accepted"].length);
  });

  it("음소거 중에 도착한 체결은 기준선만 갱신해 소리를 다시 켠 뒤 되감아 울리지 않는다", () => {
    const env = stubAudio("running");
    const client = new QueryClient();
    useUiStore.getState().load({ ...DEFAULT_UI_PREFS, orderSettings: { ...DEFAULT_UI_PREFS.orderSettings, sound: true } }, {});

    observeOrderExecutions(client, snapshot([fill("1", 5)]));
    expect(env.oscillators).toHaveLength(0);

    useUiStore.getState().setOrderSettings({ ...DEFAULT_UI_PREFS.orderSettings, sound: false });
    observeOrderExecutions(client, snapshot([fill("1", 5), fill("2", 3)]));
    expect(env.oscillators).toHaveLength(0);

    useUiStore.getState().setOrderSettings({ ...DEFAULT_UI_PREFS.orderSettings, sound: true });
    observeOrderExecutions(client, snapshot([fill("1", 5), fill("2", 3)]));
    expect(env.oscillators).toHaveLength(0);

    observeOrderExecutions(client, snapshot([fill("1", 5), fill("2", 3), fill("3", 2)]));
    expect(env.oscillators.map((o) => o.frequencies[0]?.value)).toEqual(ORDER_SOUND_TONES.filled.map((s) => s.frequency));
  });
});
