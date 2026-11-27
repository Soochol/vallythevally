import { describe, expect, it } from "vitest";
import { krxTickSize, snapKrxPrice } from "./tickSnap";

describe("krxTickSize", () => {
  it("matches KRX stock price bands", () => {
    expect(krxTickSize(1_999)).toBe(1);
    expect(krxTickSize(2_000)).toBe(5);
    expect(krxTickSize(5_000)).toBe(10);
    expect(krxTickSize(20_000)).toBe(50);
    expect(krxTickSize(60_000)).toBe(100);
    expect(krxTickSize(250_000)).toBe(500);
    expect(krxTickSize(550_000)).toBe(1_000);
  });

  it("snaps arbitrary prices to nearest valid tick", () => {
    expect(snapKrxPrice(60_140)).toBe(60_100);
    expect(snapKrxPrice(60_160)).toBe(60_200);
    expect(snapKrxPrice(19_996)).toBe(20_000);
    expect(snapKrxPrice(12_343, true)).toBe(12_345);
  });
});
