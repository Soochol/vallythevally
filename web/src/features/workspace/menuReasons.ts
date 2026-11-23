import type { MenuItem } from "../menu/Menu";

export function mergeRepeatedReasons(items: readonly MenuItem[]): MenuItem[] {
  let previous: string | undefined;
  return items.map((item) => {
    const reason = item.kind === "action" && item.disabled ? item.disabledReason : undefined;
    const repeated = reason !== undefined && reason === previous;
    previous = reason;
    return repeated && item.kind === "action" ? { ...item, disabledReason: undefined } : item;
  });
}
