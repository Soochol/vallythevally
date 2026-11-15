import type { FinancialsPage } from "../src/api/generated/FinancialsPage";
import type { IRange } from "lightweight-charts";

type Controller = { setFinancials(page: FinancialsPage | null, message?: string): void; reload(): void };

declare global {
  interface Window {
    financialViewportProbe: {
      pointerId: number | null;
      inputEvents: { type: string; phase: "capture" | "bubble"; range: IRange<number> | null }[];
      scrolls: number[];
      ranges: IRange<number>[];
      deliveries: { cellId: string; page: FinancialsPage | null; message: string | undefined }[];
      deliver(page: FinancialsPage | null, message?: string, cellId?: string): void;
      reload(cellId?: string): void;
      hasController(cellId?: string): boolean;
      hold(): void;
      step(): Promise<void>;
      release(): void;
    };
  }
}

export function installFinancialViewportProbe(): void {
  const controllers = new Map<string, Controller>();
  const set = Map.prototype.set;
  const raf = window.requestAnimationFrame.bind(window);
  const cancel = window.cancelAnimationFrame.bind(window);
  const pending = new Map<number, FrameRequestCallback>();
  const released = new Map<number, number>();
  const scales = new WeakSet<object>();
  let id = 1_000_000;
  function isController(value: unknown): value is Controller {
    return typeof value === "object" && value !== null
      && "setFinancials" in value && typeof value.setFinancials === "function"
      && "reload" in value && typeof value.reload === "function";
  }
  function controller(cellId = "cell-0"): Controller {
    const value = controllers.get(cellId);
    if (!value) throw new Error(`Missing chart controller: ${cellId}`);
    return value;
  }
  Map.prototype.set = function (key: unknown, value: unknown) {
    if (typeof key === "string" && isController(value) && controllers.get(key) !== value) {
      set.call(controllers, key, value);
      const deliver = value.setFinancials.bind(value);
      value.setFinancials = (page, message) => {
        deliver(page, message);
        window.financialViewportProbe.deliveries.push({ cellId: key, page: structuredClone(page), message });
      };
    }
    return set.call(this, key, value);
  };
  window.financialViewportProbe = {
    pointerId: null,
    inputEvents: [],
    scrolls: [],
    ranges: [],
    deliveries: [],
    deliver: (page, message, cellId) => controller(cellId).setFinancials(page, message),
    reload: (cellId) => controller(cellId).reload(),
    hasController: (cellId = "cell-0") => controllers.has(cellId),
    hold() {
      const scale = window.chartProbe.chart.timeScale();
      if (!scales.has(scale)) {
        scales.add(scale);
        const scroll = scale.scrollToPosition.bind(scale);
        const visible = scale.setVisibleLogicalRange.bind(scale);
        scale.scrollToPosition = (position, animated) => {
          window.financialViewportProbe.scrolls.push(position);
          scroll(position, animated);
        };
        scale.setVisibleLogicalRange = (range) => {
          window.financialViewportProbe.ranges.push({ ...range });
          visible(range);
        };
      }
      window.requestAnimationFrame = (callback) => {
        pending.set(++id, callback);
        return id;
      };
      window.cancelAnimationFrame = (key) => {
        if (!pending.delete(key)) cancel(released.get(key) ?? key);
        released.delete(key);
      };
    },
    step: () => new Promise((resolve) => raf((time) => {
      for (const key of [...pending.keys()]) {
        const callback = pending.get(key);
        if (!callback) continue;
        pending.delete(key);
        callback(time);
      }
      resolve();
    })),
    release() {
      window.requestAnimationFrame = raf;
      window.cancelAnimationFrame = (key) => {
        cancel(released.get(key) ?? key);
        released.delete(key);
      };
      for (const [key, callback] of pending) released.set(key, raf((time) => {
        released.delete(key);
        callback(time);
      }));
      pending.clear();
    },
  };
  document.addEventListener("pointerdown", (event) => { window.financialViewportProbe.pointerId = event.pointerId; }, true);
  for (const type of ["pointermove", "mousemove", "touchmove"]) {
    for (const phase of ["capture", "bubble"] satisfies ("capture" | "bubble")[]) {
      document.addEventListener(type, () => {
        if (window.chartProbe) window.financialViewportProbe.inputEvents.push({ type, phase, range: window.chartProbe.chart.timeScale().getVisibleLogicalRange() });
      }, phase === "capture");
    }
  }
}
