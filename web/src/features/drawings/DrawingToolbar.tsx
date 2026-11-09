import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { surfaceFor } from "../../chart/drawings/DrawingSurface";
import { gestureHelp } from "../../chart/drawings/gestures";
import { TOOL_HOTKEYS } from "../../chart/drawings/hotkeys";
import { drawingSync, useDrawingVersion } from "../../chart/drawings/sync";
import { toolsByGroup } from "../../chart/drawings/tools";
import type { Tool } from "../../chart/drawings/toolSpec";
import { MODES, registeredModes } from "../../chart/drawings/modes";
import { useDrawingSession } from "../../stores/drawingSession";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { isTypingTarget } from "../../lib/hotkeys";

export function ToolIcon({ path }: { path: string }) { return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>; }
const GROUP_LABEL = { line: "선", fib: "피보나치", shape: "도형", note: "주석", measure: "측정" };

export function DrawingToolbar() {
  const active = useDrawingSession((s) => s.tool); const pinned = useDrawingSession((s) => s.pinnedTool);
  const prefs = useUiStore((s) => s.prefs.drawing); const slot = useSelectionStore((s) => s.activeSlot);
  const sync = drawingSync(useQueryClient()); useDrawingVersion(sync);
  const [help, setHelp] = useState(false);
  const [lastTools, setLastTools] = useState<Partial<Record<Tool["group"], Tool>>>({});
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code === "Slash" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && !isTypingTarget(e.target) && e.target instanceof HTMLElement && e.target.closest("section[aria-label^='칸 ']") && !useDrawingSession.getState().editor) { e.preventDefault(); setHelp((v) => !v); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);
  const setTool = (tool: Tool) => { setLastTools((s) => ({ ...s, [tool.group]: tool })); useDrawingSession.getState().setTool(tool.tool); surfaceFor(slot)?.focus(); };
  const setPrefs = useUiStore.getState().setDrawingPrefs;
  const action = (f: () => void) => { f(); surfaceFor(slot)?.focus(); };
  return <nav aria-label="드로잉 도구" className="drawing-toolbar max-md:hidden" onPointerDown={(e) => { if (!(e.target instanceof HTMLSelectElement)) e.preventDefault(); }}>
    <button className="draw-tool" aria-label="선택 도구" title="선택 (V)" aria-pressed={active === null} onClick={() => action(() => useDrawingSession.getState().setTool(null))}><ToolIcon path="M5 3 L5 20 L10 15 L14 22 L17 20 L13 13 L21 13 Z" /></button>
    {[...toolsByGroup()].map(([group, tools]) => {
      const t = tools.find((tool) => tool.tool === active) ?? lastTools[group] ?? tools[0]!;
      return <div className="draw-group" key={group}>
      <button className="draw-tool" title={`${t.label} (${TOOL_HOTKEYS.filter((h) => h.tool === t.tool).map((h) => h.keys).join(" / ")})${pinned === t.tool ? " · 연속" : ""}`} aria-label={t.label} aria-pressed={active === t.tool} onClick={() => setTool(t)} onDoubleClick={() => action(() => useDrawingSession.getState().setTool(t.tool, true))}><ToolIcon path={t.icon} /></button>
      <details><summary aria-label={`${GROUP_LABEL[group]} 도구 펼치기`} title={`${GROUP_LABEL[group]} 도구`}><span>›</span></summary>
        <div className="draw-tool-menu" role="menu" aria-label={`${GROUP_LABEL[group]} 도구`}>{tools.map((t) => <button role="menuitem" key={t.tool} onClick={(e) => { setTool(t); e.currentTarget.closest("details")?.removeAttribute("open"); }} onDoubleClick={() => useDrawingSession.getState().setTool(t.tool, true)}>
          <ToolIcon path={t.icon} /><span>{t.label}</span><kbd>{TOOL_HOTKEYS.find((h) => h.tool === t.tool)?.keys}</kbd></button>)}</div>
      </details>
    </div>; })}
    <div className="draw-separator" />
    {MODES.filter((mode) => mode.id !== "demo").map((mode) => <button key={mode.id} className="draw-tool" aria-label={mode.label} title={mode.label} onClick={() => action(() => useDrawingSession.setState({ tool: null, mode: mode.id }))}><ToolIcon path={mode.icon} /></button>)}
    <button className="draw-tool" aria-label="자석" title="자석 켜기/끄기 (G), 세기 바꾸기 (Shift+G)" aria-pressed={prefs.magnet} onClick={() => action(() => setPrefs({ magnet: !prefs.magnet }))}><ToolIcon path="M5 4 V13 A7 7 0 0 0 19 13 V4 H14 V13 A2 2 0 0 1 10 13 V4 Z M5 8 H10 M14 8 H19" /></button>
    <select aria-label="자석 세기" title="자석 세기 (Shift+G)" className="draw-magnet-select" value={prefs.magnetStrength} onChange={(e) => action(() => setPrefs({ magnetStrength: e.target.value === "strong" ? "strong" : "weak" }))}><option value="weak">약</option><option value="strong">강</option></select>
    <button className="draw-tool" aria-label="연속 그리기" title="연속 그리기" aria-pressed={prefs.keepDrawing} onClick={() => action(() => setPrefs({ keepDrawing: !prefs.keepDrawing }))}><ToolIcon path="M4 16 L15 5 L19 9 L8 20 L3 21 Z M14 6 L18 10 M15 17 A4 4 0 1 0 20 13 M20 13 V17 H16" /></button>
    <button className="draw-tool" aria-label="모든 드로잉 잠그기" title="모든 드로잉 잠그기" aria-pressed={prefs.lockAll} onClick={() => action(() => setPrefs({ lockAll: !prefs.lockAll }))}><ToolIcon path="M7 10 V7 A5 5 0 0 1 17 7 V10 M5 10 H19 V21 H5 Z M12 14 V17" /></button>
    <button className="draw-tool" aria-label="모든 드로잉 숨기기" title="모든 드로잉 숨기기 (Ctrl+Alt+H)" aria-pressed={prefs.hideAll} onClick={() => action(() => setPrefs({ hideAll: !prefs.hideAll }))}><ToolIcon path="M2 12 Q12 -2 22 12 Q12 26 2 12 M9 12 A3 3 0 1 0 15 12 A3 3 0 1 0 9 12" /></button>
    <button className="draw-tool" aria-label="이 종목 드로잉 모두 지우기" title="이 종목 드로잉 모두 지우기" onClick={() => action(() => {
      const surface = surfaceFor(slot); const symbol = surface?.host.view()?.symbol; if (!surface || !symbol) return;
      const all = sync.drawings(symbol).filter((d) => !d.locked && !prefs.lockAll);
      if (all.length && window.confirm(`이 종목의 드로잉 ${all.length}개를 지울까요?`)) sync.commit(slot, all.map((before) => ({ kind: "delete", before })));
    })}><ToolIcon path="M4 6 H20 M9 6 V3 H15 V6 M6 6 L7 21 H17 L18 6 M10 10 V17 M14 10 V17" /></button>
    <div className="draw-toolbar-bottom"><button className="draw-tool" aria-label="개체 목록 열기" title="개체 목록" onClick={() => useDrawingSession.setState({ panel: "objects" })}><ToolIcon path="M9 5 H21 M9 12 H21 M9 19 H21 M3 4 H5 V6 H3 Z M3 11 H5 V13 H3 Z M3 18 H5 V20 H3 Z" /></button>
      <button className="draw-tool" aria-label="드로잉 단축키 도움말" title="드로잉 단축키" onClick={() => setHelp(!help)}>?</button></div>
    {help && <div className="drawing-help" role="dialog" aria-label="드로잉 단축키"><div className="draw-dialog-head"><strong>드로잉 단축키</strong><button className="icon-btn" aria-label="도움말 닫기" onClick={() => setHelp(false)}>×</button></div>{gestureHelp(registeredModes()).map((h) => <p key={h.keys}><kbd>{h.keys}</kbd><span>{h.label}</span></p>)}</div>}
  </nav>;
}
