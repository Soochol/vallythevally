export interface WindowReclaimHandler<T = unknown> {
  readonly empty: () => T;
  readonly take: (layoutId: string, windowId: string) => T;
  readonly restore: (layoutId: string, windowId: string, saved: T) => void;
}

interface SnapshotEntry {
  readonly handler: WindowReclaimHandler;
  readonly value: unknown;
}

export interface ReclaimedWindow {
  readonly layoutId: string;
  readonly window: string;
  readonly snapshots: readonly SnapshotEntry[];
}

const handlers: WindowReclaimHandler[] = [];

export function registerWindowReclaim<T>(handler: WindowReclaimHandler<T>): () => void {
  const entry = handler as WindowReclaimHandler;
  handlers.push(entry);
  return () => {
    const index = handlers.indexOf(entry);
    if (index >= 0) handlers.splice(index, 1);
  };
}

export function swapReclaimedWindow(reclaimed: ReclaimedWindow): ReclaimedWindow {
  const current: SnapshotEntry[] = reclaimed.snapshots.map(({ handler, value }) => {
    const previous = handler.take(reclaimed.layoutId, reclaimed.window);
    handler.restore(reclaimed.layoutId, reclaimed.window, value);
    return { handler, value: previous };
  });
  return { layoutId: reclaimed.layoutId, window: reclaimed.window, snapshots: current };
}

export function reclaimWindow(layoutId: string, window: string): ReclaimedWindow {
  const snapshots: SnapshotEntry[] = handlers.map((handler) => ({
    handler,
    value: handler.empty(),
  }));
  return swapReclaimedWindow({ layoutId, window, snapshots });
}
