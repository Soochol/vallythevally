import type { ISeriesApi, SeriesType, Time } from "lightweight-charts";
import { describe, expect, it, vi } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { QuoteDepthPage } from "../../api/generated/QuoteDepthPage";
import type { QuoteTotalsPage } from "../../api/generated/QuoteTotalsPage";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
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
});
