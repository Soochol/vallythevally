import { useEffect, useId, useState } from "react";
import { Popover } from "./Popover";

interface HeldTitle { target: HTMLElement; text: string; watcher: MutationObserver | null }

export function TooltipHost() {
  const [tip, setTip] = useState<{ target: HTMLElement; text: string } | null>(null);
  const id = useId();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let held: HeldTitle | null = null;
    const hide = () => {
      clearTimeout(timer);
      setTip(null);
    };
    const release = () => {
      hide();
      if (!held) return;
      if (held.watcher) {
        held.watcher.disconnect();
        if (!held.target.hasAttribute("title")) held.target.title = held.text;
      }
      held = null;
    };
    const suppressNativeTip = (next: HeldTitle) => {
      const { target } = next;
      next.watcher = new MutationObserver(() => {
        if (!target.hasAttribute("title")) return;
        next.text = target.title;
        target.removeAttribute("title");
        setTip((shown) => shown && (next.text ? { target, text: next.text } : null));
      });
      target.removeAttribute("title");
      next.watcher.observe(target, { attributes: true, attributeFilter: ["title"] });
    };
    const hold = (target: HTMLElement, byPointer: boolean) => {
      const next: HeldTitle = { target, text: target.title, watcher: null };
      if (byPointer) suppressNativeTip(next);
      held = next;
      timer = setTimeout(() => { if (next.text) setTip({ target, text: next.text }); }, 400);
    };
    const show = (e: Event) => {
      if (!(e.target instanceof Element)) return;
      const byPointer = e.type === "pointerover";
      const next = e.target.closest<HTMLElement>("[title]");
      if (held?.target.contains(e.target) && (!next || next.contains(held.target))) {
        if (byPointer && !held.watcher) suppressNativeTip(held);
        return;
      }
      if (!next?.title) return;
      release();
      hold(next, byPointer);
    };
    const leave = (e: Event) => {
      if (e instanceof PointerEvent && e.relatedTarget instanceof Node && held?.target.contains(e.relatedTarget)) return;
      release();
    };
    document.addEventListener("pointerover", show);
    document.addEventListener("focusin", show);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusout", leave);
    document.addEventListener("pointerdown", hide);
    document.addEventListener("keydown", hide);
    return () => {
      release();
      document.removeEventListener("pointerover", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("keydown", hide);
    };
  }, []);
  useEffect(() => {
    if (!tip) return;
    const previous = tip.target.getAttribute("aria-describedby");
    tip.target.setAttribute("aria-describedby", [previous, id].filter(Boolean).join(" "));
    return () => { if (previous) tip.target.setAttribute("aria-describedby", previous); else tip.target.removeAttribute("aria-describedby"); };
  }, [id, tip]);
  return tip && <Popover key={tip.text} anchorRect={() => tip.target.getBoundingClientRect()} role="tooltip" id={id} focus={false} dismiss={false} restoreFocus={false} onClose={() => setTip(null)} className="ui-tooltip"><TipText text={tip.text} /></Popover>;
}

const KEYS_IN_TITLE = /^(.*?) \(([^()]+)\)(.*)$/;

function TipText({ text }: { text: string }) {
  const [, name, keys, rest] = KEYS_IN_TITLE.exec(text) ?? [];
  if (name === undefined || keys === undefined) return text;
  return <span className="inline-flex items-center gap-1.5">{name}<kbd>{keys}</kbd>{rest}</span>;
}
