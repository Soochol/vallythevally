import type { Cell } from "../api/generated/Cell";
import type { Layout } from "../api/generated/Layout";
import type { LayoutSummary } from "../api/generated/LayoutSummary";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { SymbolInfo } from "../api/generated/SymbolInfo";
import type { Watchlist } from "../api/generated/Watchlist";
import { ApiRequestError } from "../api/http";
import { parseChartSettings } from "../chart/settings";
import { venueFor } from "../lib/venue";
import { type CellState, DEFAULT_LAYOUT, type EditableLayout } from "../stores/layout";
import { layoutPath, UI_STATE_PATH, WATCHLIST_PATH } from "../api/userData";
import type { SaveTarget } from "../stores/persist";
import type { Unsaved } from "./saver";
import { parseUiState, type UiExtra, type UiPrefs } from "./uiState";
import { unsavedValue } from "./unsaved";

/** 복원이 읽는 곳. 시험에서는 가짜를 넣는다. */
export interface RestoreSources {
  uiState(): Promise<unknown>;
  layouts(): Promise<LayoutSummary[]>;
  layout(id: string): Promise<Layout>;
  watchlist(): Promise<Watchlist>;
  symbolInfo(code: SymbolCode): Promise<SymbolInfo>;
  /** 지난 페이지가 남긴 미저장 본문(R2, `persist/unsaved.ts`). */
  unsaved(target: SaveTarget): Unsaved | null;
}

export interface Restored {
  layout: EditableLayout;
  /** 복원하면서 저장된 값을 고쳤거나(NXT 불가 종목의 NXT 등) 미저장 본문을 되살렸다. 저장해야 한다. */
  layoutDirty: boolean;
  ui: { prefs: UiPrefs; extra: UiExtra };
  /** `lastLayoutId`가 연 레이아웃과 달라 고쳤거나 미저장 본문을 되살렸다. */
  uiDirty: boolean;
  watchlist: readonly SymbolCode[];
  /** 미저장 본문을 되살렸다. */
  watchlistDirty: boolean;
  /** 서버에 저장된 revision. 이보다 오래된 미저장 본문은 지워도 된다. */
  serverRevisions: Record<SaveTarget, number>;
  /** 자동 저장이 이어 쓸 revision. 서버 값과 되살린 미저장 본문 중 큰 것이다. */
  revisions: Record<SaveTarget, number>;
  /** 화면 아래 알림으로 띄울 문장. */
  notices: string[];
}

export const NXT_FALLBACK_NOTICE = "NXT에서 거래되지 않아 통합으로 엽니다";

const revisionOf = (raw: unknown): number => {
  const r = typeof raw === "object" && raw !== null ? (raw as { revision?: unknown }).revision : undefined;
  return typeof r === "number" ? r : 0;
};

/** 같은 주소에 남은 미저장 본문이 서버 것보다 새로우면 그 값. 탭을 닫을 때 진행 중이던 저장이 있었다는 뜻이다(R2). */
function newer(u: Unsaved | null, path: string, serverRevision: number): { value: Record<string, unknown>; revision: number } | null {
  if (u === null || u.path !== path || u.revision <= serverRevision) return null;
  const value = unsavedValue(u);
  return value && { value, revision: u.revision };
}

/** 미저장 레이아웃 본문을 서버 `Layout`처럼 읽는다. 이 화면이 쓴 것이지만 지난 판의 것일 수 있어 모양만 본다. */
function asLayout(v: Record<string, unknown>, stored: Layout): Layout | null {
  const ok = v.id === stored.id && typeof v.name === "string" && typeof v.arrangement === "string" && Array.isArray(v.cells) && typeof v.sync === "object";
  return ok ? ({ ...stored, ...v } as Layout) : null;
}

/**
 * 마지막 화면을 서버에서 되살린다(#3): UiState → 마지막 레이아웃(없으면 목록의 첫 레이아웃) → 칸마다 거래소 확인.
 * 자료마다 지난 페이지의 미저장 본문이 서버 것보다 새로우면 그것을 연다(R2).
 * 사용자 자료를 읽지 못하면(서버에 닿지 못함 등) 던진다. 종목 정보 실패는 칸 하나의 일로 다룬다.
 */
export async function restore(src: RestoreSources): Promise<Restored> {
  const [rawUi, serverWatch] = await Promise.all([src.uiState(), src.watchlist()]);
  const serverUi = revisionOf(rawUi);
  const localUi = newer(src.unsaved("ui"), UI_STATE_PATH, serverUi);
  const ui = parseUiState(localUi?.value ?? rawUi);
  const localWatch = newer(src.unsaved("watchlist"), WATCHLIST_PATH, serverWatch.revision);
  const localSymbols = localWatch && Array.isArray(localWatch.value.symbols) && localWatch.value.symbols.every((s) => typeof s === "string") ? (localWatch.value.symbols as SymbolCode[]) : null;

  const stored = await openLayout(src, ui.prefs.lastLayoutId);
  const localLayout = stored && newer(src.unsaved("layout"), layoutPath(stored.id), stored.revision);
  const opened = (stored && localLayout && asLayout(localLayout.value, stored)) || stored;
  const cells = await Promise.all((opened?.cells ?? []).map((c) => restoreCell(src, c)));
  const layout: EditableLayout = opened ? { ...withoutServerFields(opened), cells: cells.map((c) => c.cell) } : DEFAULT_LAYOUT;
  const notices = cells.some((c) => c.nxtFellBack) ? [NXT_FALLBACK_NOTICE] : [];
  const lastLayoutFixed = ui.prefs.lastLayoutId !== layout.id;
  const serverRevisions = { layout: stored?.revision ?? 0, ui: serverUi, watchlist: serverWatch.revision };
  return {
    layout,
    // 레이아웃이 하나도 없으면 기본 레이아웃을 PUT으로 만든다.
    layoutDirty: stored === null || opened !== stored || cells.some((c) => c.dirty),
    ui: lastLayoutFixed ? { ...ui, prefs: { ...ui.prefs, lastLayoutId: layout.id } } : ui,
    uiDirty: lastLayoutFixed || localUi !== null,
    watchlist: localSymbols ?? serverWatch.symbols,
    watchlistDirty: localSymbols !== null,
    serverRevisions,
    revisions: {
      layout: Math.max(serverRevisions.layout, opened !== stored ? (localLayout?.revision ?? 0) : 0),
      ui: Math.max(serverUi, localUi?.revision ?? 0),
      watchlist: Math.max(serverWatch.revision, localSymbols ? localWatch!.revision : 0),
    },
    notices,
  };
}

const withoutServerFields = ({ updatedAt: _u, revision: _r, ...rest }: Layout) => rest;

async function openLayout(src: RestoreSources, id: string | null): Promise<Layout | null> {
  if (id !== null) {
    try {
      return await src.layout(id);
    } catch (e) {
      if (!(e instanceof ApiRequestError && e.code === "not_found")) throw e;
    }
  }
  const first = (await src.layouts())[0];
  return first ? src.layout(first.id) : null;
}

interface RestoredCell {
  cell: CellState;
  dirty: boolean;
  nxtFellBack: boolean;
}

/**
 * 저장된 거래소를 `venueFor`로 다시 확인한다(ADR 0007). 칸의 `venue`는 저장 원본이므로 확인된 경우에만 바꾼다.
 * - 종목 정보를 받으면 그 결과를 쓰고, 바뀌었으면 저장한다.
 * - 받지 못하면(`unknown_symbol`, 일시 실패) 칸을 그대로 둔다. 그릴 때 `shownVenue`가 NXT를 통합으로 그린다.
 */
async function restoreCell(src: RestoreSources, raw: Cell): Promise<RestoredCell> {
  const cell: CellState = { ...raw, chartSettings: parseChartSettings(raw.chartSettings) };
  let info: Pick<SymbolInfo, "code" | "nxtEnabled">;
  try {
    info = await src.symbolInfo(cell.symbol);
  } catch {
    return { cell, dirty: false, nxtFellBack: false };
  }
  const venue = venueFor(info, cell.venue);
  if (venue === cell.venue) return { cell, dirty: false, nxtFellBack: false };
  return { cell: { ...cell, venue }, dirty: true, nxtFellBack: cell.venue === "nxt" };
}
