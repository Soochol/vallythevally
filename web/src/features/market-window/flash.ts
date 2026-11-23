const CHANGE_FADE: Keyframe[] = [
  { opacity: 1, offset: 0, easing: "ease-out" },
  { opacity: 1, offset: 0.7, easing: "ease-out" },
  { opacity: 0, offset: 1 },
];
const CHANGE_FADE_MS = 1400;
const GLOW_FADE: Keyframe[] = [{ opacity: 1, easing: "ease-out" }, { opacity: 0 }];
const GLOW_FADE_MS = 600;

const reducesMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function replay(element: Element | null, frames: Keyframe[], duration: number): void {
  if (element === null || typeof element.animate !== "function" || reducesMotion()) return;
  element.getAnimations().forEach((animation) => animation.cancel());
  element.animate(frames, { duration, fill: "forwards" });
}

export const replayChangeFade = (element: Element | null): void => replay(element, CHANGE_FADE, CHANGE_FADE_MS);

export const replayGlow = (element: Element | null): void => replay(element, GLOW_FADE, GLOW_FADE_MS);
