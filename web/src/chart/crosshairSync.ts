import type { Bar } from "../api/generated/Bar";
import type { CrosshairScope } from "../api/generated/CrosshairScope";
import type { LinkColor } from "../api/generated/LinkColor";
import type { Period } from "../api/generated/Period";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import { toChartTime } from "./time";

export type BarInterval = Readonly<{ start: UnixSeconds; end: UnixSeconds; period: Period }>;
export type PointedBar = BarInterval | null;

export const PERIOD_ORDER: Record<Period, number> = { "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30, "60m": 60, D: 1440, W: 10080, M: 43200, Q: 129600, Y: 525600 };

export function barInterval(start: UnixSeconds, period: Period): BarInterval {
  const date = new Date(toChartTime(start) * 1000);
  switch (period) {
    case "D": date.setUTCDate(date.getUTCDate() + 1); break;
    case "W": date.setUTCDate(date.getUTCDate() + 7); break;
    case "M": date.setUTCMonth(date.getUTCMonth() + 1); break;
    case "Q": date.setUTCMonth(date.getUTCMonth() + 3); break;
    case "Y": date.setUTCFullYear(date.getUTCFullYear() + 1); break;
    default: date.setUTCMinutes(date.getUTCMinutes() + PERIOD_ORDER[period]);
  }
  return { start, end: start + date.getTime() / 1000 - toChartTime(start), period };
}

export function crosshairGroupKey(scope: CrosshairScope, layoutKey: string, cell: { symbol: string; link: LinkColor | null }): string | null {
  switch (scope) {
    case "all": return layoutKey;
    case "symbol": return `${layoutKey}:symbol:${cell.symbol}`;
    case "link": return cell.link === null ? null : `${layoutKey}:link:${cell.link}`;
  }
}

export function matchingBarTime(source: BarInterval, follower: { period: Period; bars: readonly Pick<Bar, "t">[] }): UnixSeconds | null {
  const { bars, period } = follower;
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const bar = bars[mid];
    if (bar && bar.t < source.start) lo = mid + 1;
    else hi = mid;
  }
  const next = bars[lo];
  if (period === source.period) return next?.t === source.start ? next.t : null;
  if (PERIOD_ORDER[period] < PERIOD_ORDER[source.period]) return next && next.t < source.end ? next.t : null;
  const containing = next?.t === source.start ? next : bars[lo - 1];
  return containing && source.start < barInterval(containing.t, period).end ? containing.t : null;
}

type ParticipantElement = Pick<HTMLElement, "isConnected" | "clientWidth" | "clientHeight" | "checkVisibility">;

export function crosshairVisible(element: ParticipantElement): boolean {
  return element.isConnected && element.clientWidth > 0 && element.clientHeight > 0 && element.checkVisibility();
}

interface Participant {
  subscribePointedBar(listener: (bar: PointedBar) => void): () => void;
  showSyncedCrosshair(bar: PointedBar): void;
}

type Lease = { controller: Participant; element: ParticipantElement };
type Group = { participants: Set<Lease>; owner: Lease | null };

export class CrosshairSync {
  private readonly groups = new Map<string, Group>();

  connect(key: string, controller: Participant, element: ParticipantElement): () => void {
    const group = this.groups.get(key) ?? { participants: new Set<Lease>(), owner: null };
    this.groups.set(key, group);
    const lease = { controller, element };
    group.participants.add(lease);
    const unsubscribe = controller.subscribePointedBar((bar) => {
      if (!group.participants.has(lease)) return;
      if (group.participants.size === 1 && group.owner === null) return;
      const pointed = crosshairVisible(element) ? bar : null;
      if (pointed === null && group.owner !== lease) return;
      group.owner = pointed === null ? null : lease;
      for (const peer of group.participants) {
        peer.controller.showSyncedCrosshair(peer !== lease && crosshairVisible(peer.element) ? pointed : null);
      }
    });
    return () => {
      unsubscribe();
      if (!group.participants.delete(lease)) return;
      controller.showSyncedCrosshair(null);
      if (group.owner === lease) {
        group.owner = null;
        for (const peer of group.participants) peer.controller.showSyncedCrosshair(null);
      }
      if (group.participants.size === 0) this.groups.delete(key);
    };
  }
}

export const crosshairSync = new CrosshairSync();
