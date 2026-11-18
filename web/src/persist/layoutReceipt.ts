import { chartWindows, type EditableLayout } from "../stores/layout";
import type { SaveState } from "./saver";

export type ReceiptChange = "saved" | "changed";

export interface ReceiptLayout {
  readonly id: string;
  readonly charts: ReadonlySet<string>;
}

export interface LayoutReceipt {
  holds(layoutId: string, windowId: string): boolean;
  mark(): number;
  droppedSince(windowId: string, mark: number): boolean;
  current(): ReceiptLayout | null;
  failed(): boolean;
  subscribe(listener: (change: ReceiptChange) => void): () => void;
}

export interface LayoutSend {
  saved(): void;
  unsure(stale: boolean): void;
}

export interface ReceiptSession {
  send(revision: number, charts: ReadonlySet<string>): LayoutSend;
  state(state: SaveState): void;
  end(): void;
}

export interface LayoutReceiptRecorder extends LayoutReceipt {
  begin(layout: () => EditableLayout, serverCharts?: readonly string[]): ReceiptSession;
}

type ServerLayout = { revision: number; charts: ReadonlySet<string> | null };

interface Session {
  layout: () => EditableLayout;
  saved: ServerLayout;
  unsure: ServerLayout[];
  sending: Set<ReadonlySet<string>>;
  sent: { mark: number; charts: ReadonlySet<string> }[];
  failed: boolean;
}

const SENT_HISTORY = 64;

const localCharts = (layout: EditableLayout): ReadonlySet<string> => new Set<string>(chartWindows(layout).map((w) => w.id));

const serverMayLack = (s: Session, id: string): boolean =>
  [s.saved, ...s.unsure].some(({ charts }) => charts === null || !charts.has(id)) || [...s.sending].some((charts) => !charts.has(id));

export function createLayoutReceipt(): LayoutReceiptRecorder {
  let session: Session | null = null;
  let lastMark = 0;
  const listeners = new Set<(change: ReceiptChange) => void>();
  const notify = (change: ReceiptChange) => { for (const listener of [...listeners]) listener(change); };

  return {
    holds(layoutId, windowId) {
      if (!session) return true;
      const layout = session.layout();
      if (layoutId !== layout.id) return false;
      return !localCharts(layout).has(windowId) || serverMayLack(session, windowId);
    },
    mark: () => lastMark,
    droppedSince: (windowId, mark) => session?.sent.some((sent) => sent.mark > mark && !sent.charts.has(windowId)) ?? false,
    current() {
      if (!session) return null;
      const layout = session.layout();
      return { id: layout.id, charts: localCharts(layout) };
    },
    failed: () => session?.failed ?? false,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    begin(layout, serverCharts) {
      const own: Session = {
        layout,
        saved: { revision: -Infinity, charts: serverCharts ? new Set(serverCharts) : null },
        unsure: [],
        sending: new Set(),
        sent: [],
        failed: false,
      };
      session = own;
      const live = () => session === own;
      notify("changed");
      return {
        send(revision, charts) {
          const sent: ServerLayout = { revision, charts };
          own.sending.add(charts);
          own.sent = [...own.sent, { mark: ++lastMark, charts }].slice(-SENT_HISTORY);
          const finish = () => {
            own.sending.delete(charts);
            if (live()) notify("changed");
          };
          return {
            saved() {
              if (live() && revision > own.saved.revision) own.saved = sent;
              if (live()) own.unsure = own.unsure.filter((l) => l.revision > own.saved.revision);
              finish();
            },
            unsure(stale) {
              if (live() && revision > own.saved.revision) own.unsure = [...own.unsure, stale ? { revision, charts: null } : sent];
              finish();
            },
          };
        },
        state(state) {
          if (!live()) return;
          const failed = state.kind === "failed";
          const changed = failed !== own.failed;
          own.failed = failed;
          if (state.kind === "saved") notify("saved");
          else if (changed) notify("changed");
        },
        end() {
          if (!live()) return;
          session = null;
          notify("changed");
        },
      };
    },
  };
}

export const layoutReceipt = createLayoutReceipt();
