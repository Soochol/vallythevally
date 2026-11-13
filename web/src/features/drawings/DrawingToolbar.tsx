import { Popover } from "../overlay/Popover";
import { Menu } from "../menu/Menu";
import { Icon, DRAWING_ICONS, CloseIcon, StarIcon } from "../icons";
import { useEffect, useRef, useState } from "react";
import { surfaceFor } from "../../chart/drawings/DrawingSurface";
import { gestureHelp } from "../../chart/drawings/gestures";
import { TOOL_HOTKEYS } from "../../chart/drawings/hotkeys";
import { toolsByGroup } from "../../chart/drawings/tools";
import type { Tool } from "../../chart/drawings/toolSpec";
import { MODES, registeredModes } from "../../chart/drawings/modes";
import { useDrawingSession } from "../../stores/drawingSession";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { ownsChartKeyboard } from "../overlay/topLayer";
import { menuIndex } from "../overlay/position";
import { toolOf } from "../../chart/drawings/tools";
import { isTypingTarget } from "../../lib/hotkeys";

const GROUP_LABEL = { line: "선", fib: "피보나치", shape: "도형", note: "주석", measure: "측정" };

export function DrawingToolbar() {
  const active = useDrawingSession((s) => s.tool); const pinned = useDrawingSession((s) => s.pinnedTool);
  const prefs = useUiStore((s) => s.prefs.drawing); const slot = useSelectionStore((s) => s.activeSlot);
  const [help, setHelp] = useState(false);
  const root = useRef<HTMLElement>(null);
  const helpButton = useRef<HTMLButtonElement>(null);
  const [lastTools, setLastTools] = useState<Partial<Record<Tool["group"], Tool>>>({});
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!ownsChartKeyboard(e) && e.code === "Slash" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && !isTypingTarget(e.target) && e.target instanceof HTMLElement && e.target.closest("section[aria-label^='칸 ']") && !useDrawingSession.getState().editor) { e.preventDefault(); setHelp((v) => !v); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);
  const setTool = (tool: Tool) => { setLastTools((s) => ({ ...s, [tool.group]: tool })); useDrawingSession.getState().setTool(tool.tool); surfaceFor(slot)?.focus(); };
  const setPrefs = useUiStore.getState().setDrawingPrefs;
  const action = (f: () => void) => { f(); surfaceFor(slot)?.focus(); };
  return <nav ref={root} data-chart-control aria-label="드로잉 도구" className="drawing-toolbar ui-island max-md:hidden">
    <button className="draw-tool" data-active-tool aria-label="선택 도구" title="선택 (V)" aria-pressed={active === null} onClick={() => action(() => useDrawingSession.getState().setTool(null))}><Icon path={DRAWING_ICONS.pointer} /></button>
    {[...toolsByGroup()].map(([group, tools]) => {
      const t = tools.find((tool) => tool.tool === active) ?? lastTools[group] ?? tools[0]!;
      return <div className="draw-group" key={group}>
      <button className="draw-tool" data-active-tool title={`${t.label} (${TOOL_HOTKEYS.filter((h) => h.tool === t.tool).map((h) => h.keys).join(" / ")})${pinned === t.tool ? " · 연속" : ""}`} aria-label={t.label} aria-pressed={active === t.tool} onClick={() => setTool(t)} onDoubleClick={() => action(() => useDrawingSession.getState().setTool(t.tool, true))}><Icon path={t.icon} /></button>
      {tools.length > 1 && <ToolGroup label={`${GROUP_LABEL[group]} 도구`} tools={tools} onChoose={setTool} />}
    </div>; })}
    {prefs.pinnedTools.map((id) => {
      const tool = toolOf(id); if (!tool) return null;
      return <button key={id} className="draw-tool" data-active-tool aria-label={`${tool.label} 고정 도구`} title={`${tool.label} (${TOOL_HOTKEYS.find((h) => h.tool === id)?.keys ?? ""}) · 고정`} aria-pressed={active === id} onClick={() => setTool(tool)} onDoubleClick={() => action(() => useDrawingSession.getState().setTool(id, true))}><Icon path={tool.icon} /></button>;
    })}
    <div className="draw-separator" />
    {MODES.filter((mode) => mode.id !== "demo").map((mode) => <button key={mode.id} className="draw-tool" aria-label={mode.label} title={mode.label} onClick={() => action(() => useDrawingSession.setState({ tool: null, mode: mode.id }))}><Icon path={mode.icon} /></button>)}
    <MagnetButton action={action} />
    <button className="draw-tool" aria-label="연속 그리기" title="연속 그리기" aria-pressed={prefs.keepDrawing} onClick={() => action(() => setPrefs({ keepDrawing: !prefs.keepDrawing }))}><Icon path={DRAWING_ICONS.keepDrawing} /></button>
    <div className="draw-toolbar-bottom"><button className="draw-tool" aria-label="개체 목록 열기" title="개체 목록" onClick={() => useSelectionStore.getState().showRightPanel("objects")}><Icon path={DRAWING_ICONS.objects} /></button>
      <button ref={helpButton} className="draw-tool" aria-label="드로잉 단축키 도움말" title="드로잉 단축키" onClick={() => setHelp(!help)}>?</button></div>
    {help && <Popover anchor={helpButton} placement="top" onClose={() => setHelp(false)} className="drawing-help" role="dialog" aria-label="드로잉 단축키"><div className="draw-dialog-head"><strong>드로잉 단축키</strong><button className="icon-btn" aria-label="도움말 닫기" onClick={() => setHelp(false)}><CloseIcon /></button></div>{gestureHelp(registeredModes()).map((h) => <p key={h.keys}><kbd>{h.keys}</kbd><span>{h.label}</span></p>)}</Popover>}
  </nav>;
}

function ToolGroup({ label, tools, onChoose }: { label: string; tools: readonly Tool[]; onChoose(tool: Tool): void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const pinned = useUiStore((s) => s.prefs.drawing.pinnedTools);
  const typed = useRef({ text: "", at: 0 });
  const aboveDock = () => {
    const own = trigger.current?.getBoundingClientRect();
    const dock = trigger.current?.closest("nav")?.getBoundingClientRect();
    return own && dock ? { left: own.left, right: own.right, top: dock.top, bottom: dock.bottom } : own;
  };
  return <div className="draw-group-toggle"><button ref={trigger} type="button" aria-label={`${label} 펼치기`} title={label} aria-haspopup="menu" aria-expanded={open} className="draw-group-dot" onClick={() => setOpen(!open)}><svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="2" fill="currentColor" /></svg></button>
    {open && <Popover data-chart-control anchor={trigger} anchorRect={aboveDock} placement="top" role="menu" aria-label={label} className="draw-tool-menu" onClose={() => setOpen(false)} onKeyDown={(e) => {
      e.stopPropagation();
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Tab") { setOpen(false); return; }
      const letters = e.key.length === 1 && !e.ctrlKey && !e.metaKey && e.key !== " ";
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && !letters) return;
      e.preventDefault();
      const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role^=menuitem]")];
      if (letters) { const now = Date.now(); typed.current = { text: now - typed.current.at < 600 ? typed.current.text + e.key : e.key, at: now }; }
      const index = buttons.findIndex((b) => b === document.activeElement);
      buttons[menuIndex(buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent ?? ""), index, e.key, letters ? typed.current.text : "")]?.focus();
    }}>
      {tools.map((tool) => <div className="draw-tool-choice" key={tool.tool}>
        <button type="button" role="menuitem" onClick={() => { onChoose(tool); setOpen(false); }}><Icon path={tool.icon} size={16} /><span>{tool.label}</span><kbd>{TOOL_HOTKEYS.find((h) => h.tool === tool.tool)?.keys}</kbd></button>
        <button type="button" role="menuitemcheckbox" aria-label={`${tool.label} 막대에 고정`} aria-checked={pinned.includes(tool.tool)} title="막대에 고정" onClick={() => useUiStore.getState().setDrawingPrefs({ pinnedTools: pinned.includes(tool.tool) ? pinned.filter((id) => id !== tool.tool) : [...pinned, tool.tool] })}><StarIcon size={16} /></button>
      </div>)}
    </Popover>}
  </div>;
}
function MagnetButton({ action }: { action(f: () => void): void }) {
  const prefs = useUiStore((s) => s.prefs.drawing);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => clear, []);
  return <div ref={root}>
    <button className="draw-tool" aria-label="자석" title="자석 켜기/끄기 (G), 세기 바꾸기 (Shift+G) · 우클릭 또는 길게 누르기" aria-pressed={prefs.magnet} aria-haspopup="menu" aria-expanded={open}
      onContextMenu={(e) => { e.preventDefault(); held.current = true; setOpen(true); }}
      onPointerDown={(e) => { if (e.button !== 0) return; held.current = false; timer.current = setTimeout(() => { held.current = true; setOpen(true); }, 500); }}
      onPointerUp={clear} onPointerCancel={clear} onPointerLeave={clear}
      onClick={() => { if (!held.current) action(() => useUiStore.getState().setDrawingPrefs({ magnet: !prefs.magnet })); held.current = false; }}><Icon path={DRAWING_ICONS.magnet} /></button>
    {open && <Menu label="자석 세기" root={root} onClose={() => setOpen(false)} items={[
      { kind: "radio", label: "약", checked: prefs.magnetStrength === "weak", onSelect: () => useUiStore.getState().setDrawingPrefs({ magnetStrength: "weak" }) },
      { kind: "radio", label: "강", checked: prefs.magnetStrength === "strong", onSelect: () => useUiStore.getState().setDrawingPrefs({ magnetStrength: "strong" }) },
    ]} />}
  </div>;
}
