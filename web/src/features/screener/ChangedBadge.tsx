export const CHANGED = "변경됨";

export function ChangedBadge() {
  return <span className="flex-none rounded-s border border-warning px-1 text-xs text-warning">{CHANGED}</span>;
}
