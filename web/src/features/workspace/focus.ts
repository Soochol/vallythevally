import type { WindowId } from "../../layout/kinds";

const programmaticFocus = new WeakSet<HTMLElement>();

function revealTab(target: HTMLElement) {
  if (target.getAttribute("role") !== "tab") return;
  const strip = target.closest<HTMLElement>('[role="tablist"]');
  if (!strip) return;
  const tab = target.getBoundingClientRect(), area = strip.getBoundingClientRect();
  if (tab.left < area.left) strip.scrollLeft += tab.left - area.left;
  else if (tab.right > area.right) strip.scrollLeft += tab.right - area.right;
}

export function focusWithoutActivation(target: HTMLElement | null) {
  if (!target) return;
  revealTab(target);
  const alreadyMarked = programmaticFocus.has(target);
  programmaticFocus.add(target);
  try { target.focus({ preventScroll: true }); }
  finally { if (!alreadyMarked) programmaticFocus.delete(target); }
}

export const isProgrammaticFocus = (target: EventTarget) => target instanceof HTMLElement && programmaticFocus.has(target);

function exposed(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && target.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
}

export function focusAfterClose(active: WindowId) {
  const preferred = document.querySelector<HTMLElement>(`[data-window-header="${active}"]`);
  const headers = Array.from(document.querySelectorAll<HTMLElement>("[data-window-header]")).sort((first, second) => Number(second.parentElement?.style.zIndex ?? 0) - Number(first.parentElement?.style.zIndex ?? 0));
  const header = [preferred, ...headers].find((target) => target !== null && exposed(target));
  if (header) { focusWithoutActivation(header); return; }
  const preferredTab = document.getElementById(`window-tab-${active}`);
  const tabs = [preferredTab, ...document.querySelectorAll<HTMLElement>('[role=tab][aria-selected=true]')];
  for (const tab of tabs) {
    if (!tab || tab.getAttribute("aria-selected") !== "true") continue;
    revealTab(tab);
    if (exposed(tab)) { focusWithoutActivation(tab); return; }
  }
  const add = document.querySelector<HTMLElement>('button[aria-label="창 더하기"]');
  if (add && exposed(add)) focusWithoutActivation(add);
}
