import { placeOverlay, type Placement, type Rect } from "./position";
interface Layer { panel: HTMLElement; options: LayerOptions }
const layers: Layer[] = [];
export function ownsChartKeyboard(event: KeyboardEvent): boolean {
  return layers.some((layer) => layer.options.blockChartKeys !== false)
    || (event.key === "Escape" && layers.length > 0)
    || (event.target instanceof Element && event.target.closest("[popover]:popover-open") !== null);
}
const onKey = (event: KeyboardEvent) => {
  const top = layers.at(-1);
  if (top && event.key === "Escape" && !event.isComposing) {
    event.preventDefault(); event.stopImmediatePropagation(); top.options.onClose();
  }
};
let outsideClick: AbortController | null = null;
function consumeOutsidePointer(event: PointerEvent) {
  event.preventDefault(); event.stopPropagation();
  outsideClick?.abort();
  const gesture = new AbortController();
  outsideClick = gesture;
  const release = () => { gesture.abort(); if (outsideClick === gesture) outsideClick = null; };
  const click = (event: MouseEvent) => {
    if (event.detail > 0 || event.type === "contextmenu") { event.preventDefault(); event.stopImmediatePropagation(); }
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
  const outside = !top.panel.contains(event.target) && !top.options.trigger?.contains(event.target);
  if (outside || (top.options.backdrop && event.target === top.panel)) {
    if (top.options.blockChartKeys !== false) consumeOutsidePointer(event);
    top.options.onClose();
  }
};
export interface LayerOptions {
  anchor?: () => Rect | undefined;
  trigger?: HTMLElement | null;
  placement?: Placement;
  restoreFocus?: boolean;
  focus?: boolean;
  dismiss?: boolean;
  follow?: boolean;
  backdrop?: boolean;
  blockChartKeys?: boolean;
  onClose(): void;
}
export function mountLayer(panel: HTMLElement, options: LayerOptions) {
  const trigger = options.trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  panel.setAttribute("popover", "manual");
  panel.showPopover();
  const layer = { panel, options: { ...options, trigger } };
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
    const position = placeOverlay(anchor, panel.getBoundingClientRect(), { width: innerWidth, height: innerHeight }, options.placement);
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
    panel.dataset.side = position.side;
  };
  place();
  let frame = 0;
  if (options.follow) {
    const follow = () => { place(); frame = requestAnimationFrame(follow); };
    frame = requestAnimationFrame(follow);
  }
  const observer = new ResizeObserver(place);
  observer.observe(panel);
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);
  if (options.focus !== false) (panel.querySelector<HTMLElement>("[autofocus]") ?? panel.querySelector<HTMLElement>("button[aria-checked=true]") ?? panel.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea, [tabindex='0']") ?? panel).focus();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place, true);
    const index = layers.indexOf(layer);
    if (index >= 0) layers.splice(index, 1);
    if (!layers.length) {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    }
    if (panel.matches(":popover-open")) panel.hidePopover();
    if (options.restoreFocus !== false && trigger?.isConnected) trigger.focus({ preventScroll: true });
  };
}
