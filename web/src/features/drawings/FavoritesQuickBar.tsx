import { useLayoutEffect, useRef, useState } from "react";
import { surfaceFor } from "../../chart/drawings/DrawingSurface";
import { toolOf } from "../../chart/drawings/tools";
import type { WindowId } from "../../layout/kinds";
import { useDrawingSession } from "../../stores/drawingSession";
import { useSelectionStore } from "../../stores/selection";
import { useActionKeys, useUiStore } from "../../stores/ui";
import { CloseIcon, DRAWING_ICONS, Icon } from "../icons";
import { toolTitle } from "./DrawingToolbar";

export function FavoritesQuickBar({ cellId }: { cellId: WindowId }) {
  const activeCell = useSelectionStore((s) => s.activeCell);
  const prefs = useUiStore((s) => s.prefs.drawing);
  const activeTool = useDrawingSession((s) => s.tool);
  const keys = useActionKeys();
  const barRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [clamped, setClamped] = useState<{ left: number; top: number } | null>(null);
  const drag = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null);
  const pinnedTools = prefs.pinnedTools.flatMap((id) => toolOf(id) ?? []);
  const shown = cellId === activeCell && prefs.favoritesBar && !prefs.toolbarHidden && pinnedTools.length > 0;

  useLayoutEffect(() => {
    if (!shown) return;
    const el = barRef.current;
    const host = el?.offsetParent;
    if (!el || !(host instanceof HTMLElement)) return;
    const clampNow = () => {
      const target = prefs.favoritesBarAt;
      if (!target) {
        setClamped(null);
        return;
      }
      const maxX = Math.max(8, host.clientWidth - el.offsetWidth - 8);
      const maxY = Math.max(8, host.clientHeight - el.offsetHeight - 8);
      const next = { left: Math.max(8, Math.min(target.x, maxX)), top: Math.max(8, Math.min(target.y, maxY)) };
      setClamped((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
    };
    clampNow();
    const observer = new ResizeObserver(clampNow);
    observer.observe(el);
    observer.observe(host);
    return () => observer.disconnect();
  }, [shown, prefs.favoritesBarAt, prefs.favoritesBarVertical, pinnedTools.length]);

  if (!shown) return null;

  const surface = surfaceFor(cellId);
  const setPrefs = useUiStore.getState().setDrawingPrefs;
  const posStyle = prefs.favoritesBarAt
    ? { left: clamped?.left ?? prefs.favoritesBarAt.x, top: clamped?.top ?? prefs.favoritesBarAt.y }
    : { right: 76, bottom: 38 };

  return (
    <div
      ref={barRef}
      data-chart-control
      role="toolbar"
      aria-label="즐겨찾기 빠른 도구"
      data-vertical={prefs.favoritesBarVertical || undefined}
      data-dragging={dragging || undefined}
      className="draw-fav-bar"
      style={posStyle}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="draw-fav-grip"
        aria-label="즐겨찾기 퀵 바 옮기기"
        title="끌어서 옮기기"
        onPointerDown={(e) => {
          e.preventDefault();
          const el = barRef.current;
          const host = el?.offsetParent;
          if (!el || !(host instanceof HTMLElement)) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          drag.current = { x: e.clientX, y: e.clientY, baseX: el.offsetLeft, baseY: el.offsetTop };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          const el = barRef.current;
          const host = el?.offsetParent;
          if (!d || !el || !(host instanceof HTMLElement)) return;
          const x = Math.max(8, Math.min(host.clientWidth - el.offsetWidth - 8, d.baseX + e.clientX - d.x));
          const y = Math.max(8, Math.min(host.clientHeight - el.offsetHeight - 8, d.baseY + e.clientY - d.y));
          setPrefs({ favoritesBarAt: { x, y } });
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
        }}
      >
        <Icon path={DRAWING_ICONS.grip} size={14} />
      </button>
      {pinnedTools.map((tool) => (
        <button
          key={tool.tool}
          type="button"
          className="draw-fav-btn"
          aria-label={`${tool.label} 빠른 도구`}
          title={toolTitle(tool, keys, "즐겨찾기")}
          aria-pressed={activeTool === tool.tool}
          onClick={() => {
            useDrawingSession.getState().setTool(cellId, tool.tool);
            surface?.focus();
          }}
          onDoubleClick={() => {
            useDrawingSession.getState().setTool(cellId, tool.tool, true);
            surface?.focus();
          }}
        >
          <Icon path={tool.icon} size={16} />
        </button>
      ))}
      <span className="draw-fav-sep" />
      <button
        type="button"
        className="draw-fav-mini"
        aria-label={prefs.favoritesBarVertical ? "가로로 눕히기" : "세로로 세우기"}
        title={prefs.favoritesBarVertical ? "가로로 눕히기" : "세로로 세우기"}
        onClick={() => setPrefs({ favoritesBarVertical: !prefs.favoritesBarVertical })}
      >
        {prefs.favoritesBarVertical ? "↔" : "↕"}
      </button>
      <button
        type="button"
        className="draw-fav-mini"
        aria-label="즐겨찾기 퀵 바 닫기"
        title="퀵 바 숨기기"
        onClick={() => setPrefs({ favoritesBar: false })}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
