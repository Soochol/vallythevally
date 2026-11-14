import { useEffect, useId, useState } from "react";
import { Popover } from "./Popover";

interface HeldTitle { target: HTMLElement; text: string | null; restore: (() => void) | null }

const dropTitle = (target: HTMLElement) => Element.prototype.removeAttribute.call(target, "title");

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
      held?.restore?.();
      held = null;
    };
    const suppressNativeTip = (next: HeldTitle) => {
      const { target } = next;
      let mirrored: string | null = null;
      const ownsDescription = () => target.getAttribute("aria-description") === mirrored;
      const describe = (text: string | null) => {
        if (!ownsDescription()) return;
        mirrored = text && text !== target.innerText ? text : null;
        if (mirrored) target.setAttribute("aria-description", mirrored); else target.removeAttribute("aria-description");
      };
      const follow = (text: string | null) => {
        next.text = text;
        describe(text);
        setTip((shown) => shown && (text ? { target, text } : null));
      };
      const takeTitle = () => {
        const text = target.getAttribute("title");
        dropTitle(target);
        follow(text);
      };
      const watcher = new MutationObserver(() => { if (target.hasAttribute("title")) takeTitle(); });
      target.removeAttribute = (name: string) => {
        if (name.toLowerCase() === "title") follow(null);
        Element.prototype.removeAttribute.call(target, name);
      };
      takeTitle();
      watcher.observe(target, { attributes: true, attributeFilter: ["title"] });
      next.restore = () => {
        watcher.disconnect();
        Reflect.deleteProperty(target, "removeAttribute");
        if (mirrored !== null && ownsDescription()) target.removeAttribute("aria-description");
        if (next.text !== null && !target.hasAttribute("title")) target.title = next.text;
      };
    };
    const hold = (target: HTMLElement, byPointer: boolean) => {
      const next: HeldTitle = { target, text: target.title, restore: null };
      if (byPointer) suppressNativeTip(next);
      held = next;
      timer = setTimeout(() => { if (next.text) setTip({ target, text: next.text }); }, 400);
    };
    const show = (e: Event) => {
      if (!(e.target instanceof Element)) return;
      const byPointer = e.type === "pointerover";
      const next = e.target.closest<HTMLElement>("[title]");
      if (held?.target.contains(e.target) && (!next || next.contains(held.target))) {
        if (byPointer && !held.restore) suppressNativeTip(held);
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
