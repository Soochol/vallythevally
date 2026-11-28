export type BrowserContextMenuEvent = Pick<MouseEvent, "defaultPrevented" | "shiftKey" | "target">;

export interface ContextMenuGuardTarget {
  addEventListener(type: "contextmenu", listener: (event: MouseEvent) => void): void;
  removeEventListener(type: "contextmenu", listener: (event: MouseEvent) => void): void;
}

const ACTIVE_CONTENT_EDITABLE_VALUES = new Set(["", "true", "plaintext-only"]);

function resolveContextElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

export function isEditableContextTarget(target: EventTarget | null): boolean {
  const element = resolveContextElement(target);
  if (element === null) return false;
  if (element.closest("input, textarea") !== null) return true;
  const editableHost = element.closest("[contenteditable]");
  if (editableHost !== null) {
    const rawValue = editableHost.getAttribute("contenteditable");
    const normalized = rawValue === null ? "" : rawValue.toLowerCase();
    if (ACTIVE_CONTENT_EDITABLE_VALUES.has(normalized)) return true;
    if (normalized === "false") return false;
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

export function shouldBlockBrowserContextMenu(event: BrowserContextMenuEvent): boolean {
  if (event.defaultPrevented || event.shiftKey) return false;
  return !isEditableContextTarget(event.target);
}

export function installBrowserContextMenuGuard(target: ContextMenuGuardTarget = window): () => void {
  const handleContextMenu = (event: MouseEvent) => {
    if (shouldBlockBrowserContextMenu(event)) {
      event.preventDefault();
    }
  };
  target.addEventListener("contextmenu", handleContextMenu);
  return () => {
    target.removeEventListener("contextmenu", handleContextMenu);
  };
}
