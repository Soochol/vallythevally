import { describe, expect, it } from "vitest";
import { activeCallAuction } from "./callAuctionSession";

const kstUnix = (hour: number, minute: number, second = 0): number =>
  Math.floor(Date.UTC(2026, 10, 9, hour - 9, minute, second) / 1000);

describe("activeCallAuction", () => {
  it("detects KRX closing auction 15:20~15:30 for krx and combined venues", () => {
    const t = kstUnix(15, 24, 30);
    expect(activeCallAuction(t, "krx", false)?.kind).toBe("closing");
    expect(activeCallAuction(t, "combined", true)?.kind).toBe("closing");
    expect(activeCallAuction(t, "nxt", true)).toBeNull();
  });

  it("detects KRX opening auction 08:50~09:00 for krx and combined venues", () => {
    const t = kstUnix(8, 55, 0);
    expect(activeCallAuction(t, "krx", false)?.kind).toBe("opening");
    expect(activeCallAuction(t, "combined", false)?.kind).toBe("opening");
    expect(activeCallAuction(t, "nxt", true)).toBeNull();
  });

  it("detects NXT after auction 15:30~15:40 only when nxtEnabled and venue is nxt or combined", () => {
    const t = kstUnix(15, 35, 0);
    expect(activeCallAuction(t, "nxt", true)?.kind).toBe("nxt_after");
    expect(activeCallAuction(t, "combined", true)?.kind).toBe("nxt_after");
    expect(activeCallAuction(t, "krx", true)).toBeNull();
    expect(activeCallAuction(t, "combined", false)).toBeNull();
  });

  it("returns null during regular continuous trading", () => {
    expect(activeCallAuction(kstUnix(10, 30, 0), "combined", true)).toBeNull();
  });
});
