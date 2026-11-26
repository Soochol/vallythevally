import { describe, expect, it } from "vitest";
import {
  decodeHogaSpan,
  encodeHogaSpan,
  EVENT_KIND_BOOK,
  EVENT_KIND_TRADE,
  openHogaSpan,
} from "./hogaDecode";

describe("hogaDecode", () => {
  it("바이너리 HOGA 구간을 인코딩·디코딩하고 carry-forward 키프레임은 이벤트 타임라인에서 제외한다", () => {
    const m545 = 545 * 60_000;
    const buffer = encodeHogaSpan({
      date: 20261125,
      startMinute: 545,
      lengthMinutes: 5,
      symbol: "005930_AL",
      streams: [
        {
          kind: "book",
          columns: {
            recv_ms: [m545 - 5_000, m545 + 1_000, m545 + 2_500],
            t_s: [32_695, 32_701, 32_702],
            ask_px1: [71_100, 71_200, 71_200],
            bid_px1: [71_000, 71_100, 71_100],
            ask_qty1: [100, 220, 180],
            bid_qty1: [150, 190, 210],
            ask_total: [1_000, 1_200, 1_160],
            bid_total: [1_100, 1_300, 1_320],
          },
        },
        {
          kind: "trades",
          columns: {
            recv_ms: [m545 + 1_200, m545 + 2_500],
            t_s: [32_701, 32_702],
            price: [71_200, 71_100],
            qty: [40, -25],
            venue: [1, 2],
          },
        },
      ],
    });

    const decoded = decodeHogaSpan(buffer);
    const span = openHogaSpan(decoded);

    expect(span.symbol).toBe("005930_AL");
    expect(span.streams.book?.rows).toBe(3);
    expect(Array.from(span.streams.book!.columns.ask_px1!)).toEqual([71_100, 71_200, 71_200]);
    expect(Array.from(span.streams.trades!.columns.qty!)).toEqual([40, -25]);

    expect(Array.from(span.eventRecvMs)).toEqual([m545 + 1_000, m545 + 1_200, m545 + 2_500, m545 + 2_500]);
    expect(Array.from(span.eventKind)).toEqual([
      EVENT_KIND_BOOK,
      EVENT_KIND_TRADE,
      EVENT_KIND_BOOK,
      EVENT_KIND_TRADE,
    ]);
    expect(Array.from(span.eventRow)).toEqual([1, 0, 2, 1]);
  });
});
