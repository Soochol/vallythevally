import { Badge } from "../ui/Badge";

export const CHANGED = "변경됨";

export function ChangedBadge() {
  return <Badge tone="warning" className="flex-none">{CHANGED}</Badge>;
}
