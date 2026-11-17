import { type RefObject, useEffect } from "react";
import { progressOf, stepOf } from "./scrollProgress";

export function useScrollStory(container: RefObject<HTMLElement | null>, story: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const scroller = container.current;
    const section = story.current;
    const pin = section?.parentElement;
    if (!enabled || !scroller || !section || !pin) return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const progress = progressOf(scroller.scrollTop, pin.offsetTop, pin.offsetHeight, scroller.clientHeight);
      scroller.style.setProperty("--p", progress.toFixed(4));
      section.dataset.step = String(stepOf(progress));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    apply();
    return () => {
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      scroller.style.removeProperty("--p");
    };
  }, [container, story, enabled]);
}
