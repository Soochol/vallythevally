import { placeOverlay, type Placement, type Rect } from "./position";
interface Layer { panel: HTMLElement; options: LayerOptions }
const layers: Layer[] = [];
const PASSTHROUGH = "[data-layer-passthrough]";
export function ownsChartKeyboard(event: Pick<KeyboardEvent, "key" | "target">): boolean {
  return layers.some((layer) => layer.options.blockChartKeys !== false)
    || (event.key === "Escape" && (layers.length > 0 || (event.target instanceof Element && event.target.closest("[data-chart-escape-owner]") !== null)))
    || (event.target instanceof Element && event.target.closest("[popover]:popover-open") !== null);
}
export function ownsWorkspaceTab(target: EventTarget | null): boolean {
  return layers.some((layer) => layer.options.blockChartKeys !== false || (target instanceof Node && layer.panel.contains(target)));
}
const onKey = (event: KeyboardEvent) => {
  const top = layers.at(-1);
  if (top && event.key === "Escape" && !event.isComposing) {
    event.preventDefault(); event.stopImmediatePropagation(); top.options.onClose("escape");
  }
};
let outsideClick: AbortController | null = null;
function consumeOutsidePointer(event: PointerEvent, released?: Node) {
  if (!released) { event.preventDefault(); event.stopPropagation(); }
  outsideClick?.abort();
  const gesture = new AbortController();
  outsideClick = gesture;
  const release = () => { gesture.abort(); if (outsideClick === gesture) outsideClick = null; };
  const click = (event: MouseEvent) => {
    const reachesReleased = released !== undefined && event.type === "click" && event.target instanceof Node && released.contains(event.target);
    if (!reachesReleased && (event.detail > 0 || event.type === "contextmenu")) { event.preventDefault(); event.stopImmediatePropagation(); }
    release();
  };
  const options = { capture: true, once: true, signal: gesture.signal };
  window.addEventListener("click", click, options);
  window.addEventListener("contextmenu", click, options);
  window.addEventListener("pointerdown", release, options);
  window.addEventListener("pointercancel", release, options);
  window.addEventListener("blur", release, { once: true, signal: gesture.signal });
}
const onDown = (event: PointerEvent) => {
  const top = layers.at(-1);
  if (!top || !(event.target instanceof Node)) return;
  const outside = !top.panel.contains(event.target) && !top.options.trigger?.contains(event.target) && !top.options.isInside?.(event.target) && !(event.target instanceof Element && event.target.closest(PASSTHROUGH) !== null);
  if (outside || (top.options.backdrop && event.target === top.panel)) {
    if (top.options.blockChartKeys !== false) consumeOutsidePointer(event, event.button === 0 && top.options.releasesClick?.(event.target) ? (event.target instanceof Element ? event.target.closest("button") ?? event.target : event.target) : undefined);
    top.options.onClose("outside");
  }
};
export interface LayerOptions {
  isInside?(target: Node): boolean;
  releasesClick?(target: Node): boolean;
  anchor?: () => Rect | undefined;
  trigger?: HTMLElement | null;
  focusTarget?: HTMLElement | null;
  placement?: Placement;
  restoreFocus?: boolean;
  focus?: boolean;
  dismiss?: boolean;
  follow?: boolean;
  fitBelow?: number;
  minTop?(): number;
  backdrop?: boolean;
  blockChartKeys?: boolean;
  onClose(reason: "escape" | "outside"): void;
}
const FIT_MARGIN = 16;

export function mountLayer(panel: HTMLElement, options: LayerOptions) {
  const focusTarget = options.focusTarget ?? options.trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  panel.setAttribute("popover", "manual");
  panel.showPopover();
  const layer = { panel, options };
  if (options.dismiss !== false) {
    if (!layers.length) {
      window.addEventListener("keydown", onKey, true);
      document.addEventListener("pointerdown", onDown, true);
    }
    layers.push(layer);
  }
  const place = () => {
    const anchor = options.anchor?.();
    if (!anchor) return;
    if (options.fitBelow !== undefined) {
      const room = innerHeight - anchor.bottom - FIT_MARGIN;
      const maxHeight = room >= options.fitBelow ? `${room}px` : "";
      if (panel.style.maxHeight !== maxHeight) {
        if (maxHeight) panel.style.maxHeight = maxHeight;
        else panel.style.removeProperty("max-height");
      }
    }
    const position = placeOverlay(anchor, panel.getBoundingClientRect(), { width: innerWidth, height: innerHeight }, options.placement);
    const top = Math.max(position.top, options.minTop?.() ?? 0);
    if (top > position.top) {
      const maxHeight = `${Math.max(0, innerHeight - top - FIT_MARGIN)}px`;
      if (panel.style.maxHeight !== maxHeight) panel.style.maxHeight = maxHeight;
    }
    const leftPx = `${position.left}px`;
    const topPx = `${top}px`;
    if (panel.style.left !== leftPx) panel.style.left = leftPx;
    if (panel.style.top !== topPx) panel.style.top = topPx;
    if (panel.dataset.side !== position.side) panel.dataset.side = position.side;
  };
  place();
  let frame = 0;
  const schedulePlace = () => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      place();
    });
  };
  const observer = new ResizeObserver(schedulePlace);
  observer.observe(panel);
  if (options.follow && options.trigger) {
    observer.observe(options.trigger);
    if (options.trigger.parentElement) observer.observe(options.trigger.parentElement);
  }
  const restyled = new MutationObserver(place);
  if (options.follow && options.trigger) {
    restyled.observe(options.trigger, { attributes: true });
    if (options.trigger.parentElement) restyled.observe(options.trigger.parentElement, { attributes: true, childList: true });
    for (let around = options.trigger.parentElement?.parentElement; around; around = around.parentElement) restyled.observe(around, { attributes: true });
  }
  window.addEventListener("resize", schedulePlace);
  window.addEventListener("scroll", schedulePlace, true);
  if (options.focus !== false) (panel.querySelector<HTMLElement>("[autofocus]") ?? panel.querySelector<HTMLElement>("button[aria-checked=true]") ?? panel.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea, [tabindex='0']") ?? panel).focus();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    restyled.disconnect();
    window.removeEventListener("resize", schedulePlace);
    window.removeEventListener("scroll", schedulePlace, true);
    const index = layers.indexOf(layer);
    if (index >= 0) layers.splice(index, 1);
    if (!layers.length) {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    }
    if (panel.matches(":popover-open")) panel.hidePopover();
    if (options.restoreFocus !== false && focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
  };
}
