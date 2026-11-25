import { describe, expect, it, vi } from "vitest";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import type { HighValueRequest } from "./HighValueConfirm";
import { createOrderCommands, type OrderCommandContext, type OrderCommandSink } from "./orderCommand";
import { REJECT_TEXT, REPLAY_LOCKED_TEXT } from "./statusText";

function makeContext(overrides: Partial<OrderCommandContext> = {}): OrderCommandContext {
  return {
    code: "005930",
    symbolInfo: { code: "005930", name: "삼성전자", market: "KOSPI", kind: "stock", nxtEnabled: true } as never,
    currentAccount: { keyId: "k1", broker: "kiwoom", alias: "기본", ref: "acc1", tail: "12", state: "on", message: null } as never,
    orderVenue: "combined",
    mock: false,
    nxtNotTraded: false,
    replayLocked: false,
    quantity: 10,
    keepLastEntry: true,
    capacity: {
      sellableQuantity: 50,
      buying: { policy: "cash_only", cashAmount: 10_000_000, amount: 10_000_000 },
    },
    groups: new Map(),
    openOrdersListedAt: 1_000,
    ...overrides,
  };
}

function makeSink() {
  const confirms: HighValueRequest[] = [];
  const sink: OrderCommandSink = {
    place: vi.fn(),
    modifyAll: vi.fn(),
    cancelOne: vi.fn(),
    cancelAtPrice: vi.fn(),
    say: vi.fn(),
    setConfirm: vi.fn((req) => confirms.push(req)),
    rememberEntry: vi.fn(),
    readPending: () => [],
    nowMs: () => Date.UTC(2026, 10, 25, 1, 0, 0),
  };
  return { sink, confirms };
}

const SAMPLE_ORDER: TradingOpenOrder = {
  orderNo: "ORD-1",
  code: "005930",
  name: "삼성전자",
  side: "buy",
  quantity: 10,
  price: 70_000,
  openQuantity: 10,
  status: "접수",
  orderedAt: "090000",
  originalOrderNo: null,
  venue: "combined",
};

describe("createOrderCommands", () => {
  it("blocks place, modify, ladder cancel, and chip drop at the single replay-lock gate", () => {
    let ctx = makeContext({ replayLocked: true });
    const { sink } = makeSink();
    const commands = createOrderCommands(() => ctx, sink);

    commands.place("buy", 70_000);
    commands.modifyOrders("buy", 70_000, [SAMPLE_ORDER], 70_100);
    commands.cancelLadderOne("ORD-1");
    commands.cancelLadderGroups([{ side: "buy", price: 70_000 }]);
    commands.drop({ kind: "chip", group: { side: "buy", price: 70_000, orders: [SAMPLE_ORDER] } as never }, { kind: "cancel" });

    expect(sink.place).not.toHaveBeenCalled();
    expect(sink.modifyAll).not.toHaveBeenCalled();
    expect(sink.cancelOne).not.toHaveBeenCalled();
    expect(sink.cancelAtPrice).not.toHaveBeenCalled();
    expect(sink.say).toHaveBeenCalledTimes(5);
    expect(sink.say).toHaveBeenCalledWith({ tone: "error", text: REPLAY_LOCKED_TEXT });

    ctx = makeContext({ replayLocked: false });
    commands.place("buy", 70_000);
    expect(sink.place).toHaveBeenCalledTimes(1);
    expect(sink.rememberEntry).toHaveBeenCalledWith(10, sink.nowMs());
  });

  it("rejects NXT-unavailable orders and offers max-quantity retry on buying-power block", () => {
    const ctx = makeContext({ nxtNotTraded: true });
    const { sink } = makeSink();
    createOrderCommands(() => ctx, sink).place("buy", 70_000);
    expect(sink.say).toHaveBeenCalledWith({ tone: "error", text: REJECT_TEXT.nxt_unavailable });
    expect(sink.place).not.toHaveBeenCalled();

    const tightCtx = makeContext({
      quantity: 20,
      capacity: { sellableQuantity: 50, buying: { policy: "cash_only", cashAmount: 350_000, amount: 350_000 } },
    });
    const tightSink = makeSink();
    createOrderCommands(() => tightCtx, tightSink.sink).place("buy", 70_000);
    expect(tightSink.sink.place).not.toHaveBeenCalled();
    const status = vi.mocked(tightSink.sink.say).mock.calls[0]?.[0];
    expect(status?.tone).toBe("error");
    expect(status?.action).toBeDefined();
    status?.action?.run();
    expect(tightSink.sink.place).toHaveBeenCalledWith(expect.objectContaining({ side: "buy", price: 70_000, quantity: 5 }));
  });

  it("requires high-value confirmation and re-checks replay lock when confirmed", () => {
    let ctx = makeContext({
      quantity: 2_000,
      capacity: { sellableQuantity: 2_000, buying: { policy: "cash_only", cashAmount: 300_000_000, amount: 300_000_000 } },
    });
    const { sink, confirms } = makeSink();
    const commands = createOrderCommands(() => ctx, sink);

    commands.place("buy", 70_000);
    expect(sink.place).not.toHaveBeenCalled();
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.amount).toBe(140_000_000);

    ctx = makeContext({ ...ctx, replayLocked: true });
    confirms[0]?.run();
    expect(sink.place).not.toHaveBeenCalled();
    expect(sink.say).toHaveBeenCalledWith({ tone: "error", text: REPLAY_LOCKED_TEXT });
  });

  it("매수 전량 상태에서는 클릭한 가격 기준으로 최대 수량을 재계산해 주문하고 1주도 못 사면 한도 초과를 알린다", () => {
    const ctx = makeContext({
      quantity: 100,
      buyFull: true,
      capacity: { sellableQuantity: 50, buying: { policy: "cash_only", cashAmount: 7_000_000, amount: 7_000_000 } },
    });
    const { sink } = makeSink();
    const commands = createOrderCommands(() => ctx, sink);

    commands.place("buy", 70_100);
    expect(sink.place).toHaveBeenCalledWith(expect.objectContaining({ side: "buy", price: 70_100, quantity: 99 }));

    commands.place("buy", 69_000);
    expect(sink.place).toHaveBeenCalledWith(expect.objectContaining({ side: "buy", price: 69_000, quantity: 101 }));

    const tinyCtx = makeContext({
      quantity: 1,
      buyFull: true,
      capacity: { sellableQuantity: 0, buying: { policy: "cash_only", cashAmount: 65_000, amount: 65_000 } },
    });
    const tinySink = makeSink();
    createOrderCommands(() => tinyCtx, tinySink.sink).place("buy", 70_000);
    expect(tinySink.sink.place).not.toHaveBeenCalled();
    expect(tinySink.sink.say).toHaveBeenCalledWith({ tone: "error", text: "현금 주문가능 65,000원을 넘습니다 (미수 막음) · 살 수 있는 수량이 없습니다" });
  });
});
