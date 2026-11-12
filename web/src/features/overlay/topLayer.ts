import { placeOverlay, type Placement, type Rect } from "./position";
const layers: HTMLElement[] = [];
export interface LayerOptions {
  anchor?: () => Rect | undefined;
  trigger?: HTMLElement | null;
  placement?: Placement;
  restoreFocus?: boolean;
  focus?: boolean;
  dismiss?: boolean;
  follow?: boolean;
  onClose(): void;
}
export function mountLayer(panel: HTMLElement, options: LayerOptions) {
  const trigger = options.trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  panel.setAttribute("popover", "manual");
  panel.showPopover();
  if (options.dismiss !== false) layers.push(panel);
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
  const key = (e: KeyboardEvent) => {
    if (layers.at(-1) !== panel || e.isComposing) return;
    if (e.key === "Escape" && options.dismiss !== false) {
      e.preventDefault(); e.stopImmediatePropagation(); options.onClose();
    }
  };
  const down = (e: PointerEvent) => {
    if (layers.at(-1) !== panel || options.dismiss === false) return;
    if (e.target instanceof Node && !panel.contains(e.target) && !trigger?.contains(e.target)) options.onClose();
  };
  window.addEventListener("keydown", key, true);
  document.addEventListener("pointerdown", down);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place, true);
    window.removeEventListener("keydown", key, true);
    document.removeEventListener("pointerdown", down);
    const index = layers.indexOf(panel);
    if (index >= 0) layers.splice(index, 1);
    if (panel.matches(":popover-open")) panel.hidePopover();
    if (options.restoreFocus !== false && trigger?.isConnected) trigger.focus({ preventScroll: true });
  };
}
