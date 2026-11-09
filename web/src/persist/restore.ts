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
import { parseUiState, type UiExtra, type UiPrefs } from "./uiState";

/** 복원이 읽는 곳. 시험에서는 가짜를 넣는다. */
export interface RestoreSources {
  uiState(): Promise<unknown>;
  layouts(): Promise<LayoutSummary[]>;
  layout(id: string): Promise<Layout>;
  watchlist(): Promise<Watchlist>;
  symbolInfo(code: SymbolCode): Promise<SymbolInfo>;
}

export interface Restored {
  layout: EditableLayout;
  /** 복원하면서 저장된 값을 고쳤다(NXT 불가 종목의 NXT 등). 고친 값을 저장해야 한다. */
  layoutDirty: boolean;
  ui: { prefs: UiPrefs; extra: UiExtra };
  /** `lastLayoutId`가 연 레이아웃과 달라 고쳤다. */
  uiDirty: boolean;
  watchlist: readonly SymbolCode[];
  /** 화면 아래 알림으로 띄울 문장. */
  notices: string[];
}

export const NXT_FALLBACK_NOTICE = "NXT에서 거래되지 않아 통합으로 엽니다";

/**
 * 마지막 화면을 서버에서 되살린다(#3): UiState → 마지막 레이아웃(없으면 목록의 첫 레이아웃) → 칸마다 거래소 확인.
 * 사용자 자료를 읽지 못하면(서버에 닿지 못함 등) 던진다. 종목 정보 실패는 칸 하나의 일로 다룬다.
 */
export async function restore(src: RestoreSources): Promise<Restored> {
  const [rawUi, watchlist] = await Promise.all([src.uiState(), src.watchlist()]);
  const ui = parseUiState(rawUi);
  const stored = await openLayout(src, ui.prefs.lastLayoutId);
  const cells = await Promise.all((stored?.cells ?? []).map((c) => restoreCell(src, c)));
  const layout: EditableLayout = stored ? { ...withoutUpdatedAt(stored), cells: cells.map((c) => c.cell) } : DEFAULT_LAYOUT;
  const notices = cells.some((c) => c.nxtFellBack) ? [NXT_FALLBACK_NOTICE] : [];
  const uiDirty = ui.prefs.lastLayoutId !== layout.id;
  return {
    layout,
    // 레이아웃이 하나도 없으면 기본 레이아웃을 PUT으로 만든다.
    layoutDirty: stored === null || cells.some((c) => c.dirty),
    ui: uiDirty ? { ...ui, prefs: { ...ui.prefs, lastLayoutId: layout.id } } : ui,
    uiDirty,
    watchlist: watchlist.symbols,
    notices,
  };
}

const withoutUpdatedAt = ({ updatedAt: _, ...rest }: Layout) => rest;

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
