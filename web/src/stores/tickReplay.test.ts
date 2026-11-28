import { afterEach, describe, expect, test, vi } from "vitest";
import type { SymbolCode } from "../api/generated/SymbolCode";
import { barInterval } from "../chart/crosshairSync";
import { ReplayEngine } from "../features/replay-page/replayEngine";
import { buildReplaySession } from "../features/replay-page/replayModel";
import { windowId } from "../layout/kinds";
import { DEFAULT_UI_PREFS } from "../persist/uiState";
import { useBookReplayStore } from "./bookReplay";
import { exitActiveReplay, useTickReplayStore } from "./tickReplay";
import { useUiStore } from "./ui";

const CODE: SymbolCode = "005930";

afterEach(() => {
  useTickReplayStore.getState().stop();
  useBookReplayStore.getState().clear();
  useUiStore.setState({ prefs: DEFAULT_UI_PREFS });
});

describe("useTickReplayStore", () => {
  test("start turns off 호가 복기 and clears pointed bar, stop returns to idle", () => {
    useUiStore.getState().setBookReplay(true);
    useBookReplayStore.getState().point(CODE, barInterval(1_700_000_000, "5m"), 71_000);
    expect(useUiStore.getState().prefs.bookReplay).toBe(true);
    expect(useBookReplayStore.getState().pointed).not.toBeNull();

    const runId = useTickReplayStore.getState().start({
      cellId: windowId("cell-0"),
      symbol: CODE,
      link: "a",
      date: "20261125",
      initialSec: 9 * 3600,
      autoPlay: true,
    });

    expect(useUiStore.getState().prefs.bookReplay).toBe(false);
    expect(useBookReplayStore.getState().pointed).toBeNull();

    const active = useTickReplayStore.getState().state;
    expect(active.kind).toBe("active");
    if (active.kind === "active") {
      expect(active.runId).toBe(runId);
      expect(active.load).toEqual({ kind: "loading" });
      expect(active.target.symbol).toBe(CODE);
    }

    useTickReplayStore.getState().stop();
    expect(useTickReplayStore.getState().state).toEqual({ kind: "idle" });
  });

  test("exitActiveReplay stops tick replay when active and disables 호가 복기 otherwise", () => {
    useTickReplayStore.getState().start({
      cellId: windowId("cell-0"),
      symbol: CODE,
      link: "a",
      date: "20261125",
      initialSec: 9 * 3600,
      autoPlay: false,
    });
    expect(useTickReplayStore.getState().state.kind).toBe("active");

    exitActiveReplay();
    expect(useTickReplayStore.getState().state).toEqual({ kind: "idle" });

    useUiStore.getState().setBookReplay(true);
    useBookReplayStore.getState().point(CODE, barInterval(1_700_000_000, "5m"), 71_000);
    exitActiveReplay();
    expect(useUiStore.getState().prefs.bookReplay).toBe(false);
    expect(useBookReplayStore.getState().pointed).toBeNull();
  });

  test("updateSession replaces session metadata without disposing the attached engine", () => {
    const runId = useTickReplayStore.getState().start({
      cellId: windowId("cell-0"),
      symbol: CODE,
      link: "a",
      date: "20261125",
      initialSec: 9 * 3600,
      autoPlay: false,
    });
    const baseDay = {
      symbol: CODE,
      date: "20261125",
      coverage: "collected" as const,
      previousClose: null,
      covered: [[540, 545]] as [number, number][],
      books: [],
      trades: [],
    };
    const firstSession = buildReplaySession({
      day: baseDay,
      bars1m: [],
      quoteTotals: [],
      programPoints: [],
      previousClose: null,
      symbolKind: "common",
    });
    const enrichedSession = buildReplaySession({
      day: baseDay,
      bars1m: [],
      quoteTotals: [],
      programPoints: [],
      previousClose: 70_000,
      symbolKind: "common",
    });
    const engine = new ReplayEngine({ code: CODE, session: firstSession, meta: null });
    const disposeSpy = vi.spyOn(engine, "dispose");

    useTickReplayStore.getState().attachEngine(runId, {
      session: firstSession,
      engine,
      isArchive: false,
    });
    useTickReplayStore.getState().updateSession(runId, enrichedSession, false);

    const active = useTickReplayStore.getState().state;
    expect(disposeSpy).not.toHaveBeenCalled();
    expect(active.kind).toBe("active");
    if (active.kind === "active") {
      expect(active.engine).toBe(engine);
      expect(active.session).toBe(enrichedSession);
      expect(active.session?.previousClose).toBe(70_000);
    }
  });
});
