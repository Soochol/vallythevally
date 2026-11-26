import type { ISeriesApi, SeriesType, Time } from "lightweight-charts";
import { describe, expect, it, vi } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { MicroEvent } from "../../api/generated/MicroEvent";
import type { QuoteDepthPage } from "../../api/generated/QuoteDepthPage";
import type { QuoteTotalsPage } from "../../api/generated/QuoteTotalsPage";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { FeedEvent, FeedRequest } from "../../api/socket";
import type { ShownVenue } from "../../lib/venue";
import type { IndicatorConfig } from "../settings";
import type { ThemeTokens } from "../theme";
import { QuoteIndicatorController, quoteStateMessage } from "./quoteFamily";

const TOKENS = { text2: "text2", up: "#FF6B78", down: "#5B9BFF" } as unknown as ThemeTokens;
const T0 = Date.parse("2026-11-25T09:00:00+09:00") / 1000;
const bar = (minute: number): Bar => ({ t: (T0 + minute * 60) as UnixSeconds, o: 100, h: 110, l: 90, c: 105, v: 1000 });

const TOTALS_CONFIG: IndicatorConfig = {
  id: "totals",
  spec: { kind: "quoteTotals" },
  panel: "quotes",
  visible: true,
  style: { colors: ["ind-1"], width: 1 },
};

const DEPTH_CONFIG: IndicatorConfig = {
  id: "depth",
  spec: { kind: "quoteDepth", source: "priceMax", topLevels: null, maxOpacity: 0.7, aboveBars: false, askColor: null, bidColor: null },
  panel: "price",
  visible: true,
  style: { colors: ["ind-1"], width: 1 },
};

function fakeSeries() {
  const events: string[] = [];
  const api = {
    attachPrimitive: vi.fn(() => events.push("attach")),
    detachPrimitive: vi.fn(() => events.push("detach")),
  } as unknown as ISeriesApi<SeriesType, Time>;
  return { api, events };
}

describe("QuoteIndicatorController", () => {
  it("single-sources quote status messages across totals and depth", () => {
    expect(quoteStateMessage("disabled")).toBe("수집 폴더 미설정");
    expect(quoteStateMessage("notCollected")).toBe("수집하지 않는 종목");
    expect(quoteStateMessage("failed")).toBe("호가 자료 조회 실패");
    expect(quoteStateMessage("ready")).toBeNull();
    expect(quoteStateMessage("loading")).toBeNull();
  });

  it("detaches heatmap primitive before reattaching on main series replacement", () => {
    const first = fakeSeries();
    const second = fakeSeries();
    const controller = new QuoteIndicatorController({
      bars: () => [],
      tokens: () => TOKENS,
      configs: () => [],
      onTotalsChanged: () => {},
      onDepthChanged: () => {},
    });

    controller.attachMainSeries(first.api);
    expect(first.events).toEqual(["attach"]);

    controller.detachMainSeries(first.api);
    controller.attachMainSeries(second.api);
    expect(first.events).toEqual(["attach", "detach"]);
    expect(second.events).toEqual(["attach"]);

    controller.dispose();
    expect(second.events).toEqual(["attach", "detach"]);
  });

  it("opens and covers quote feeds automatically when target and bars are set", async () => {
    const totalsFetch = vi.fn(async (): Promise<QuoteTotalsPage> => ({ status: "ok", points: [{ t: T0 as UnixSeconds, ask: 100, bid: 200 }], gaps: [] } as never));
    const depthFetch = vi.fn(async (): Promise<QuoteDepthPage> => ({ status: "ok", points: [], gaps: [] } as never));
    const onTotalsChanged = vi.fn();
    const onDepthChanged = vi.fn();
    let configs: IndicatorConfig[] = [TOTALS_CONFIG, DEPTH_CONFIG];
    const bars = [bar(0), bar(1), bar(2)];

    const controller = new QuoteIndicatorController(
      {
        bars: () => bars,
        tokens: () => TOKENS,
        configs: () => configs,
        onTotalsChanged,
        onDepthChanged,
      },
      { fetchQuoteTotals: totalsFetch, fetchQuoteDepth: depthFetch, now: () => (T0 + 300) as UnixSeconds },
    );

    controller.setTarget({ symbol: "005930", venue: "combined" as ShownVenue, period: "1m" });
    expect(totalsFetch).toHaveBeenCalledTimes(1);
    expect(depthFetch).toHaveBeenCalledTimes(1);

    configs = [];
    controller.syncFeeds();
    expect(controller.totalsView()).toBeNull();
    expect(controller.depthView("depth")).toBeUndefined();

    controller.dispose();
  });

  it("loads micro events only when showSpoof or showIceberg is enabled and surfaces hover detail", async () => {
    const depthFetch = vi.fn(async (): Promise<QuoteDepthPage> => ({
      symbol: "005930",
      venue: "combined",
      period: "1m",
      source: "priceMax",
      days: [{ date: "20261125", state: "ready" }],
      points: [{ t: T0 as UnixSeconds, asks: [[70_100, 1_000]], bids: [[70_000, 1_000]] }],
      gaps: [],
    } as never));
    const microFetch = vi.fn(async () => ({
      symbol: "005930",
      date: "20261125",
      source: "flow" as const,
      events: [
        {
          recvMs: (T0 + 15) * 1000,
          kind: "spoof_cancel" as const,
          side: "ask" as const,
          priceWon: 70_100,
          cancelledOrAbsorbedQty: 2_000,
          displayedQty: 2_500,
          executedQty: 100,
          ratioBps: 9_500,
        },
      ],
    }));
    const onDepthChanged = vi.fn();
    let configs: IndicatorConfig[] = [DEPTH_CONFIG];
    const bars = [bar(0), bar(1)];

    const controller = new QuoteIndicatorController(
      {
        bars: () => bars,
        tokens: () => TOKENS,
        configs: () => configs,
        onTotalsChanged: () => {},
        onDepthChanged,
      },
      { fetchQuoteDepth: depthFetch, fetchMicroEvents: microFetch, now: () => (T0 + 300) as UnixSeconds },
    );

    controller.setTarget({ symbol: "005930", venue: "combined" as ShownVenue, period: "1m" });
    expect(microFetch).toHaveBeenCalledTimes(0);

    const enabledConfig: IndicatorConfig = {
      ...DEPTH_CONFIG,
      spec: { ...DEPTH_CONFIG.spec, kind: "quoteDepth", source: "priceMax", topLevels: null, maxOpacity: 0.7, aboveBars: false, askColor: null, bidColor: null, showSpoof: true },
    };
    configs = [enabledConfig];
    controller.syncFeeds();
    expect(microFetch).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      const row = controller.depthRow(enabledConfig, T0 as UnixSeconds, TOKENS);
      expect(row.values.some((v) => v.text.includes("허수 취소 95%"))).toBe(true);
    });

    controller.dispose();
  });

  it("loads historical bar dates instead of hardcoding today and fetches newly scrolled dates", async () => {
    const prevDayT0 = Date.parse("2026-11-24T09:00:00+09:00") / 1000;
    const earlierDayT0 = Date.parse("2026-11-23T09:00:00+09:00") / 1000;
    const depthFetch = vi.fn(async (): Promise<QuoteDepthPage> => ({
      symbol: "005930",
      venue: "combined",
      period: "1m",
      source: "priceMax",
      days: [{ date: "20261124", state: "ready" }],
      points: [{ t: prevDayT0 as UnixSeconds, asks: [[70_100, 1_000]], bids: [[70_000, 1_000]] }],
      gaps: [],
    } as never));
    const microFetch = vi.fn(async (_symbol: string, date: string) => ({
      symbol: "005930",
      date,
      source: "store" as const,
      events: date === "20261124"
        ? [{
            recvMs: (prevDayT0 + 20) * 1000,
            kind: "spoof_cancel" as const,
            side: "ask" as const,
            priceWon: 70_100,
            cancelledOrAbsorbedQty: 3_000,
            displayedQty: 3_500,
            executedQty: 100,
            ratioBps: 9_600,
          }]
        : [],
    }));
    const subscribeFeed = vi.fn(() => vi.fn());
    const enabledConfig: IndicatorConfig = {
      ...DEPTH_CONFIG,
      spec: { ...DEPTH_CONFIG.spec, kind: "quoteDepth", source: "priceMax", topLevels: null, maxOpacity: 0.7, aboveBars: false, askColor: null, bidColor: null, showSpoof: true },
    };
    let bars: Bar[] = [{ t: prevDayT0 as UnixSeconds, o: 100, h: 110, l: 90, c: 105, v: 1000 }];

    const controller = new QuoteIndicatorController(
      {
        bars: () => bars,
        tokens: () => TOKENS,
        configs: () => [enabledConfig],
        onTotalsChanged: () => {},
        onDepthChanged: () => {},
      },
      { fetchQuoteDepth: depthFetch, fetchMicroEvents: microFetch, subscribeFeed, now: () => (T0 + 300) as UnixSeconds },
    );

    controller.setTarget({ symbol: "005930", venue: "combined" as ShownVenue, period: "1m" });
    expect(microFetch.mock.calls.map((call) => call[1])).toEqual(["20261124"]);
    expect(subscribeFeed).toHaveBeenCalledTimes(0);

    await vi.waitFor(() => {
      const row = controller.depthRow(enabledConfig, prevDayT0 as UnixSeconds, TOKENS);
      expect(row.values.some((v) => v.text.includes("허수 취소 96%"))).toBe(true);
    });

    bars = [{ t: earlierDayT0 as UnixSeconds, o: 100, h: 110, l: 90, c: 105, v: 1000 }, ...bars];
    controller.cover(bars);
    expect(microFetch.mock.calls.map((call) => call[1])).toEqual(["20261124", "20261123"]);

    controller.dispose();
  });

  it("receives live intraday micro events over WS, refetches on resync, and unsubscribes on dispose", async () => {
    const depthFetch = vi.fn(async (): Promise<QuoteDepthPage> => ({
      symbol: "005930",
      venue: "combined",
      period: "1m",
      source: "priceMax",
      days: [{ date: "20261125", state: "ready" }],
      points: [{ t: T0 as UnixSeconds, asks: [[70_100, 1_000]], bids: [[70_000, 1_000]] }],
      gaps: [],
    } as never));
    const microFetch = vi.fn(async (_symbol: string, date: string) => ({
      symbol: "005930",
      date,
      source: "flow" as const,
      events: [] as MicroEvent[],
    }));
    const unsub = vi.fn();
    let feedHandler: ((m: FeedEvent) => void) | null = null;
    const subscribeFeed = vi.fn((_req: FeedRequest, handler: (m: FeedEvent) => void) => {
      feedHandler = handler;
      return unsub;
    });
    const enabledConfig: IndicatorConfig = {
      ...DEPTH_CONFIG,
      spec: { ...DEPTH_CONFIG.spec, kind: "quoteDepth", source: "priceMax", topLevels: null, maxOpacity: 0.7, aboveBars: false, askColor: null, bidColor: null, showIceberg: true },
    };
    const bars = [bar(0), bar(1)];

    const controller = new QuoteIndicatorController(
      {
        bars: () => bars,
        tokens: () => TOKENS,
        configs: () => [enabledConfig],
        onTotalsChanged: () => {},
        onDepthChanged: () => {},
      },
      { fetchQuoteDepth: depthFetch, fetchMicroEvents: microFetch, subscribeFeed, now: () => (T0 + 300) as UnixSeconds },
    );

    controller.setTarget({ symbol: "005930", venue: "combined" as ShownVenue, period: "1m" });
    expect(subscribeFeed).toHaveBeenCalledTimes(1);
    expect(microFetch).toHaveBeenCalledTimes(1);

    feedHandler!({
      type: "feed_micro",
      sub: "s1",
      event: {
        recvMs: (T0 + 70) * 1000,
        kind: "iceberg_absorb",
        side: "bid",
        priceWon: 70_000,
        cancelledOrAbsorbedQty: 1_800,
        displayedQty: 1_000,
        executedQty: 1_800,
        ratioBps: 18_000,
      },
    });
    await vi.waitFor(() => {
      const row = controller.depthRow(enabledConfig, bar(1).t, TOKENS);
      expect(row.values.some((v) => v.text.includes("아이스버그 1.8x"))).toBe(true);
    });

    feedHandler!({ type: "resync" });
    expect(microFetch).toHaveBeenCalledTimes(2);

    controller.dispose();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
