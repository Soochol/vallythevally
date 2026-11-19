import { createElement } from "react";
import type { DrawingSurface } from "../../chart/drawings/DrawingSurface";
import type { ScreenPoint } from "../../chart/drawings/types";
import { formatBarTime } from "../../chart/time";
import { formatPrice } from "../../lib/format";
import { isIndexCode, isMinutePeriod } from "../../lib/symbol";
import { useSelectionStore } from "../../stores/selection";
import { activeWatchlist, useWatchlistStore } from "../../stores/watchlist";
import { CameraIcon, CopyIcon, DRAWING_ICONS, ExpandIcon, Icon, PlusIcon } from "../icons";
import { canCopyImage, saveSnapshot } from "../snapshot/saveSnapshot";
import { controllerFor } from "../grid/controllers";
import { jumpToBar } from "../jump/jumpToBar";
import { defaultObjectStyle } from "../../chart/drawings/objects";
import { inScope } from "../../chart/drawings/frame";
import { periodGroup } from "../../chart/drawings/periodGroup";
import { toolOf } from "../../chart/drawings/tools";
import { useLayoutStore } from "../../stores/layout";
import type { Period } from "../../api/generated/Period";
import { useDrawingSession } from "../../stores/drawingSession";
import { useUiStore } from "../../stores/ui";
import type { MenuItem } from "../menu/Menu";

const action = (label: string, onSelect: () => void): MenuItem => ({ kind: "action", label, onSelect });
const glyph = (path: string) => createElement(Icon, { path, size: 14 });

function jumpItems(surface: DrawingSurface): MenuItem[] {
  const anchor = controllerFor(surface.cellId)?.jumpAnchor();
  return anchor ? [{ kind: "action", label: anchor.label, icon: glyph("M4 12h13M12 6l6 6-6 6M21 5v14"), hint: "Alt+G", onSelect: () => void jumpToBar(surface.cellId) }] : [];
}

function chartItems(surface: DrawingSurface, at: ScreenPoint): MenuItem[] {
  const view = surface.host.view(); const point = surface.pointAt(at);
  if (!view || !point) return [];
  const toast = useSelectionStore.getState().showToast;
  const watchlist = activeWatchlist(useWatchlistStore.getState().lists, useUiStore.getState().prefs.activeWatchlistId);
  return [
    { kind: "heading", label: [formatPrice(point.price, isIndexCode(view.symbol)), ...(point.t === null ? [] : [formatBarTime(point.t, view.period)])].join(" · ") },
    { kind: "action", label: "이 가격에 수평선", icon: glyph(DRAWING_ICONS.hline), hint: "Alt+H", onSelect: () => surface.placeHorizontalLine(at) },
    { kind: "action", label: "관심종목에 넣기", icon: createElement(PlusIcon), disabled: watchlist.symbols.includes(view.symbol), onSelect: () => { useWatchlistStore.getState().add(watchlist.id, view.symbol); toast(`${watchlist.name}에 넣었습니다`); } },
    { kind: "action", label: "축 자동 맞춤", icon: createElement(ExpandIcon, { size: 14 }), onSelect: () => surface.fitPriceScale() },
    ...jumpItems(surface),
    { kind: "separator" },
    ...(canCopyImage() ? [{ kind: "action" as const, label: "차트 이미지 복사", icon: createElement(CopyIcon, { size: 14 }), hint: "Alt+Shift+S", onSelect: () => void saveSnapshot(surface.cellId, "copy") }] : []),
    { kind: "action", label: "차트 이미지 내려받기", icon: createElement(CameraIcon, { size: 14 }), hint: "Alt+S", onSelect: () => void saveSnapshot(surface.cellId, "download") },
    { kind: "separator" },
  ];
}

export function drawingMenu(surface: DrawingSurface, empty = false, at: ScreenPoint | null = null): MenuItem[] {
  const session = useDrawingSession.getState(); const prefs = useUiStore.getState().prefs.drawing;
  const selected = surface.selected();
  if (empty) {
    const view = surface.host.view(); const symbol = view?.symbol;
    const layoutId = useLayoutStore.getState().layout.id;
    const all = symbol ? surface.sync.drawings(symbol) : [];
    const here = view ? all.filter((d) => inScope(d.scope, layoutId, surface.cellId) && (d.periods === null || d.periods.includes(view.period))) : [];
    const removable = here.filter((d) => !d.locked && !prefs.lockAll);
    const group = view && isMinutePeriod(view.period) ? "분봉" : "일 이상";
    return [
      ...(at ? chartItems(surface, at) : []),
      { kind: "heading", label: here.length === all.length ? `드로잉 ${here.length}개` : `드로잉 ${here.length}개 · 모든 봉 주기 ${all.length}개` },
      ...(session.clip ? [action("붙여넣기", () => surface.paste())] : []),
      { kind: "check", label: "모든 드로잉 숨기기", checked: prefs.hideAll, onSelect: () => useUiStore.getState().setDrawingPrefs({ hideAll: !useUiStore.getState().prefs.drawing.hideAll }) },
      { kind: "check", label: "모든 드로잉 잠그기", checked: prefs.lockAll, onSelect: () => useUiStore.getState().setDrawingPrefs({ lockAll: !useUiStore.getState().prefs.drawing.lockAll }) },
      { kind: "action", label: `${group} 드로잉 모두 지우기…`, icon: glyph(DRAWING_ICONS.trash), danger: true, disabled: removable.length === 0, onSelect: () => surface.sync.commitWithUndo(surface.cellId, removable.map((before) => ({ kind: "delete", before })), `드로잉 ${removable.length}개를 지웠습니다`) },
    ];
  }
  const first = selected[0]; if (!first) return [];
  const locked = selected.every((d) => d.locked);
  const periods = (p: Period[] | null) => surface.updateSelected((d) => ({ ...d, periods: p }));
  return [
    action("세부 설정…", () => surface.openEditor(first.id)), action("복사", () => surface.copy()), action("복제", () => surface.clone()),
    ...(toolOf(first.tool)?.text ? [action("글자 고치기…", () => surface.openEditor(first.id, "text"))] : []),
    { kind: "separator" }, action(locked ? "잠금 풀기" : "잠금", () => surface.updateSelected((d) => ({ ...d, locked: !locked }))),
    { kind: "heading", label: "순서" },
    ...([ ["맨 앞으로", "front"], ["앞으로", "forward"], ["뒤로", "backward"], ["맨 뒤로", "back"] ] as const).map(([label, direction]) => action(label, () => surface.reorder(first.id, direction))),
    { kind: "heading", label: "보이는 봉 주기" }, action("모든 봉 주기", () => periods(null)),
    action("분봉만", () => periods(periodGroup("1m"))), action("일 이상만", () => periods(periodGroup("D"))),
    action("지금 봉 주기만", () => periods([surface.host.view()?.period ?? "D"])),
    { kind: "separator" }, action("기본 스타일로", () => surface.updateSelected((d) => ({ ...d, style: defaultObjectStyle(d) }))),
    { kind: "action", label: "지우기", icon: glyph(DRAWING_ICONS.trash), danger: true, onSelect: () => surface.remove(true) },
  ];
}
