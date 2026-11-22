import { describe, expect, it } from "vitest";
import { MAX_ORDER_ENTRIES, NO_ORDER_ENTRIES, type OrderEntry, orderEntryKey, parseOrderEntries, withOrderEntry } from "./orderEntries";

const entry = (quantity: number, usedAt: number, presetKind: OrderEntry["presetKind"] = "sharePresets"): OrderEntry => ({ presetKind, quantity, usedAt });

describe("호가주문 기억", () => {
  it("레이아웃이 다르면 같은 창 ID와 종목도 따로다", () => {
    expect(orderEntryKey("L1", "order", "005930")).not.toBe(orderEntryKey("L2", "order", "005930"));
    expect(orderEntryKey("L1", "order", "005930")).not.toBe(orderEntryKey("L1", "order-2", "005930"));
    expect(orderEntryKey("L1", "order", "005930")).not.toBe(orderEntryKey("L1", "order", "000660"));
    const kept = withOrderEntry(withOrderEntry(NO_ORDER_ENTRIES, orderEntryKey("L1", "order", "005930"), entry(37, 1)), orderEntryKey("L2", "order", "005930"), entry(5, 2));
    expect(Object.keys(kept)).toHaveLength(2);
  });

  it("없거나 객체가 아니면 비어 있다", () => {
    expect(parseOrderEntries(undefined)).toBe(NO_ORDER_ENTRIES);
    expect(parseOrderEntries(null)).toBe(NO_ORDER_ENTRIES);
    expect(parseOrderEntries([entry(1, 1)])).toBe(NO_ORDER_ENTRIES);
    expect(parseOrderEntries("x")).toBe(NO_ORDER_ENTRIES);
  });

  it("틀린 항목은 버리고 맞는 항목은 읽는다", () => {
    const raw = {
      ok: { presetKind: "amountPresets", quantity: 37, usedAt: 5 },
      noKind: { presetKind: "other", quantity: 37, usedAt: 5 },
      zero: { presetKind: "sharePresets", quantity: 0, usedAt: 5 },
      fraction: { presetKind: "sharePresets", quantity: 1.5, usedAt: 5 },
      text: { presetKind: "sharePresets", quantity: "7", usedAt: 5 },
      noTime: { presetKind: "sharePresets", quantity: 7 },
      infinite: { presetKind: "sharePresets", quantity: 7, usedAt: Infinity },
      nothing: null,
      array: [],
    };
    expect(parseOrderEntries(raw)).toEqual({ ok: { presetKind: "amountPresets", quantity: 37, usedAt: 5 } });
  });

  it("읽을 때 모르는 필드는 떼어 낸다", () => {
    expect(parseOrderEntries({ k: { presetKind: "sharePresets", quantity: 3, usedAt: 1, extra: true } })).toEqual({ k: entry(3, 1) });
  });

  it("300쌍을 넘으면 가장 오래 쓰지 않은 쌍부터 지운다", () => {
    let entries = NO_ORDER_ENTRIES;
    for (let at = 1; at <= MAX_ORDER_ENTRIES; at++) entries = withOrderEntry(entries, `k${at}`, entry(at, at));
    expect(Object.keys(entries)).toHaveLength(MAX_ORDER_ENTRIES);
    entries = withOrderEntry(entries, "new", entry(9, 1_000));
    expect(Object.keys(entries)).toHaveLength(MAX_ORDER_ENTRIES);
    expect(entries["k1"]).toBeUndefined();
    expect(entries["k2"]).toBeDefined();
    expect(entries["new"]).toEqual(entry(9, 1_000));
  });

  it("이미 있는 쌍을 다시 쓰면 개수는 그대로이고 값과 시각만 바뀐다", () => {
    let entries = NO_ORDER_ENTRIES;
    for (let at = 1; at <= MAX_ORDER_ENTRIES; at++) entries = withOrderEntry(entries, `k${at}`, entry(at, at));
    entries = withOrderEntry(entries, "k1", entry(77, 1_000));
    expect(Object.keys(entries)).toHaveLength(MAX_ORDER_ENTRIES);
    expect(entries["k1"]).toEqual(entry(77, 1_000));
    expect(entries["k2"]).toEqual(entry(2, 2));
    entries = withOrderEntry(entries, "new", entry(9, 2_000));
    expect(entries["k1"]).toEqual(entry(77, 1_000));
    expect(entries["k2"]).toBeUndefined();
  });

  it("상한을 넘는 저장값은 읽을 때 가장 최근 300쌍만 남긴다", () => {
    const raw = Object.fromEntries(Array.from({ length: MAX_ORDER_ENTRIES + 20 }, (_, at) => [`k${at}`, entry(at + 1, at)]));
    const parsed = parseOrderEntries(raw);
    expect(Object.keys(parsed)).toHaveLength(MAX_ORDER_ENTRIES);
    expect(parsed["k0"]).toBeUndefined();
    expect(parsed["k19"]).toBeUndefined();
    expect(parsed["k20"]).toBeDefined();
  });
});
