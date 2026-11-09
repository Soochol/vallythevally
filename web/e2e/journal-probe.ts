import { DrawingJournal, journalLock, parseJournalRecord, stageKey, STAGING_PREFIX } from "../src/chart/drawings/journal";
import { recordKey, UNSAVED_PREFIX, type Intent } from "../src/chart/drawings/outbox";
import type { DrawingBody } from "../src/chart/drawings/types";

const body: DrawingBody = {
  id: "01900000-0000-7000-8000-000000000053", symbol: "IDX:001", tool: "hline",
  points: [{ t: 1_700_000_000, price: 100 }], text: null, style: {}, locked: false,
  hidden: false, periods: null, z: 0, group: null, scope: { kind: "symbol" }, revision: 0,
};

const journalProbe = {
  DrawingJournal, journalLock, parseJournalRecord, stageKey, STAGING_PREFIX, recordKey, UNSAVED_PREFIX, body,
  intents: new Map<string, Intent>(),
  tasks: new Map<string, Promise<unknown>>(),
  release: () => {},
};

declare global {
  interface Window { journalProbe: typeof journalProbe }
}

window.journalProbe = journalProbe;
