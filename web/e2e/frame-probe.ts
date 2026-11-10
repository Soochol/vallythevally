import type { ISeriesApi, SeriesType } from "lightweight-charts";

type Series = Pick<ISeriesApi<SeriesType>, "data" | "seriesType" | "update" | "priceToCoordinate">;
type Update = Parameters<Series["update"]>[0];

declare global {
  interface Window {
    frameProbe: {
      snapshot(): { type: SeriesType; data: ReturnType<Series["data"]>; updates: Update[] }[];
      /** 주 봉 시리즈(Candlestick)가 이 가격을 그리는 y. */
      candleY(price: number): number | null;
      hold(): void;
      release(): void;
    };
  }
}

export function installFrameProbe(): void {
  const series = new Map<Series, Update[]>();
  const set = Map.prototype.set;
  const remove = Map.prototype.delete;
  const raf = window.requestAnimationFrame.bind(window);
  const cancel = window.cancelAnimationFrame.bind(window);
  const pending = new Map<number, FrameRequestCallback>();
  let id = 900_000;
  function isSeries(value: unknown): value is Series {
    return typeof value === "object" && value !== null
      && "seriesType" in value && typeof value.seriesType === "function"
      && "data" in value && typeof value.data === "function"
      && "update" in value && typeof value.update === "function";
  }
  Map.prototype.set = function (key: unknown, value: unknown) {
    if (isSeries(key) && !series.has(key)) {
      const updates: Update[] = [];
      set.call(series, key, updates);
      const update = key.update;
      key.update = function (...args: Parameters<Series["update"]>) {
        updates.push(args[0]);
        return update.apply(this, args);
      };
    }
    return set.call(this, key, value);
  };
  Map.prototype.delete = function (key: unknown) {
    if (isSeries(key)) remove.call(series, key);
    return remove.call(this, key);
  };
  window.frameProbe = {
    snapshot: () => [...series].map(([api, updates]) => ({ type: api.seriesType(), data: api.data(), updates })),
    candleY: (price) => [...series.keys()].find((api) => api.seriesType() === "Candlestick")?.priceToCoordinate(price) ?? null,
    hold() {
      window.requestAnimationFrame = (callback) => { pending.set(++id, callback); return id; };
      window.cancelAnimationFrame = (key) => { if (!pending.delete(key)) cancel(key); };
    },
    release() {
      window.requestAnimationFrame = raf;
      window.cancelAnimationFrame = cancel;
      for (const callback of pending.values()) raf(callback);
      pending.clear();
    },
  };
}
