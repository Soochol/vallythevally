import type { Rect } from "../../layout/placement";

export const DIVIDER_REACH = 3;

const YIELDS_TO = 'button, a, input, select, textarea, summary, [role=tab], [role=menu], [role=menuitem], [role=slider], [role=separator], [data-dock-junction], .window-frame, .dock-input-shield';

export function reachesDivider(point: { x: number; y: number }, rect: Rect, row: boolean, reach: number = DIVIDER_REACH): boolean {
  const across = row ? point.x : point.y;
  const along = row ? point.y : point.x;
  const start = row ? rect.x : rect.y;
  const thickness = row ? rect.w : rect.h;
  const alongStart = row ? rect.y : rect.x;
  const alongLength = row ? rect.h : rect.w;
  const inSpan = along >= alongStart && along < alongStart + alongLength;
  const inStrip = (across >= start - reach && across < start) || (across >= start + thickness && across < start + thickness + reach);
  return inSpan && inStrip;
}

function pixelsOfBar(el: Element, style: CSSStyleDeclaration, horizontal: boolean): number {
  const outer = horizontal ? (el as HTMLElement).offsetHeight - el.clientHeight : (el as HTMLElement).offsetWidth - el.clientWidth;
  const borders = horizontal ? parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) : parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
  return outer - (Number.isFinite(borders) ? borders : 0);
}

function onScrollbar(target: Element, host: Element, clientX: number, clientY: number): boolean {
  for (let el: Element | null = target; el && el !== host; el = el.parentElement) {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const scrollsY = /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight && pixelsOfBar(el, style, false) > 0;
    if (scrollsY && clientX >= box.left + el.clientLeft + el.clientWidth) return true;
    const scrollsX = /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth && pixelsOfBar(el, style, true) > 0;
    if (scrollsX && clientY >= box.top + el.clientTop + el.clientHeight) return true;
  }
  return false;
}

export function yieldsToContent(event: PointerEvent, host: Element): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return true;
  return target.closest(YIELDS_TO) !== null || onScrollbar(target, host, event.clientX, event.clientY);
}
