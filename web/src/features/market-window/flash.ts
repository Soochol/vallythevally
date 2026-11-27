const CHANGE_FADE: Keyframe[] = [
  { opacity: 1, offset: 0, easing: "ease-out" },
  { opacity: 1, offset: 0.7, easing: "ease-out" },
  { opacity: 0, offset: 1 },
];
const CHANGE_FADE_MS = 1400;
const GLOW_FADE: Keyframe[] = [{ opacity: 1, easing: "ease-out" }, { opacity: 0 }];
const GLOW_FADE_MS = 600;

const reducesMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function replay(element: Element | null, frames: Keyframe[], duration: number, playsWhenReduced: boolean, hideOnFinish: boolean): void {
  if (element === null || typeof element.animate !== "function" || (reducesMotion() && !playsWhenReduced)) return;
  element.getAnimations().forEach((animation) => animation.cancel());
  const styled = hideOnFinish && element instanceof HTMLElement ? element : null;
  if (styled) styled.style.opacity = "";
  const animation = element.animate(frames, { duration });
  if (styled) {
    animation.onfinish = () => {
      styled.style.opacity = "0";
    };
  }
}

export const replayChangeFade = (element: Element | null): void => replay(element, CHANGE_FADE, CHANGE_FADE_MS, true, true);

export const replayGlow = (element: Element | null): void => replay(element, GLOW_FADE, GLOW_FADE_MS, false, false);
