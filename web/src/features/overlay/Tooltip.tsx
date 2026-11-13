import { useEffect, useId, useState } from "react";
import { Popover } from "./Popover";
export function TooltipHost() {
  const [tip, setTip] = useState<{ target: HTMLElement; text: string } | null>(null);
  const id = useId();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let target: HTMLElement | null = null;
    const clear = () => {
      clearTimeout(timer);
      target = null;
      setTip(null);
    };
    const show = (e: Event) => {
      const next = e.target instanceof Element ? e.target.closest<HTMLElement>("[title]") : null;
      if (!next || next === target || !next.title) return;
      clear(); target = next;
      const text = next.title;
      timer = setTimeout(() => setTip({ target: next, text }), 400);
    };
    const leave = (e: Event) => {
      if (e instanceof PointerEvent && e.relatedTarget instanceof Node && target?.contains(e.relatedTarget)) return;
      clear();
    };
    document.addEventListener("pointerover", show);
    document.addEventListener("focusin", show);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusout", leave);
    document.addEventListener("pointerdown", clear);
    document.addEventListener("keydown", clear);
    return () => {
      clear();
      document.removeEventListener("pointerover", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("pointerdown", clear);
      document.removeEventListener("keydown", clear);
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
