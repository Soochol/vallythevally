import { Popover } from "../overlay/Popover";
import { Menu } from "../menu/Menu";
import { Icon, DRAWING_ICONS, CloseIcon, StarIcon } from "../icons";
import { type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { surfaceFor } from "../../chart/drawings/DrawingSurface";
import { gestureSections } from "../../chart/drawings/gestures";
import { toolsByGroup } from "../../chart/drawings/tools";
import type { Tool } from "../../chart/drawings/toolSpec";
import { MODES, registeredModes } from "../../chart/drawings/modes";
import { cellDrawing, useDrawingSession } from "../../stores/drawingSession";
import { listGroups } from "../../layout/dock/tree";
import { chartWindows, fittedDock, useLayoutStore, type EditableLayout } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useActionKeys, useUiStore } from "../../stores/ui";
import { ownsChartKeyboard } from "../overlay/topLayer";
import { menuIndex } from "../overlay/position";
import { toolOf } from "../../chart/drawings/tools";
import { isTypingTarget } from "../../lib/typingTarget";
import { allShortcutsOf, keyTitle, shortcutOf, toolActionId, type ActionKeys } from "../../lib/hotkeys";

export function toolTitle(tool: Tool, keys: ActionKeys, note?: string) {
  const shortcuts = allShortcutsOf(keys, toolActionId(tool.tool));
  return [shortcuts ? `${tool.label} (${shortcuts})` : tool.label, note].filter(Boolean).join(" · ");
}

const GROUP_LABEL = { line: "선", fib: "피보나치·갠", shape: "도형", note: "주석", measure: "측정", pattern: "패턴" };

const setToolbarHidden = (toolbarHidden: boolean) => useUiStore.getState().setDrawingPrefs({ toolbarHidden });

function usePinnedRoom(run: React.RefObject<HTMLElement | null>, count: number) {
  const [room, setRoom] = useState(Infinity);
  useLayoutEffect(() => {
    const element = run.current;
    if (!element || count === 0) return;
    const fit = () => {
      const first = element.firstElementChild;
      const gap = parseFloat(getComputedStyle(element).rowGap) || 0;
      const slot = first instanceof HTMLElement && first.offsetHeight > 0 ? first.offsetHeight + gap : 0;
      if (slot > 0) setRoom(Math.max(1, Math.floor((element.clientHeight + gap) / slot + 1e-6)));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => observer.disconnect();
  }, [run, count]);
  return Math.min(room, count);
}

function chartShown(layout: EditableLayout, mode: "dock" | "canvas") {
  if (mode === "canvas") return chartWindows(layout).length > 0;
  const dock = fittedDock(layout);
  const shown = [...listGroups(dock.root).map((group) => group.active), ...dock.floats.map((float) => float.window)];
  return layout.windows.some((w) => w.kind === "chart" && shown.includes(w.id));
}

export function DrawingToolbar() {
  const mode = useUiStore((s) => s.prefs.layoutMode);
  const shown = useLayoutStore((s) => chartShown(s.layout, mode));
  const hidden = useUiStore((s) => s.prefs.drawing.toolbarHidden);
  const cellId = useSelectionStore((s) => s.activeCell);
  const [help, setHelp] = useState(false);
  const helpAnchor = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!shown) setHelp(false); }, [shown]);
  useEffect(() => {
    if (!shown) return;
    const key = (e: KeyboardEvent) => {
      if (!ownsChartKeyboard(e) && e.code === "Slash" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && !isTypingTarget(e.target) && e.target instanceof HTMLElement && e.target.closest("section[aria-label^='칸 ']") && !cellDrawing(useDrawingSession.getState(), useSelectionStore.getState().activeCell).editor) { e.preventDefault(); setHelp((v) => !v); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [shown]);
  if (!shown) return null;
  const helpDialog = help && <DrawingHelp anchor={helpAnchor} close={() => setHelp(false)} />;
  if (hidden) return <nav data-chart-control aria-label="드로잉 도구" className="drawing-toolbar drawing-toolbar-hidden max-md:hidden">
    <button ref={helpAnchor} type="button" className="draw-rail-handle" aria-label="드로잉 도구 막대 보이기" title="드로잉 도구 막대 보이기" onClick={() => { setToolbarHidden(false); surfaceFor(cellId)?.focus(); }}><span aria-hidden="true">»</span></button>
    {helpDialog}
  </nav>;
  return <DrawingRail help={help} setHelp={setHelp} helpAnchor={helpAnchor} helpDialog={helpDialog} />;
}

interface RailHelp { help: boolean; setHelp(open: boolean): void; helpAnchor: React.RefObject<HTMLButtonElement | null>; helpDialog: React.ReactNode }

function DrawingRail({ help, setHelp, helpAnchor, helpDialog }: RailHelp) {
  const active = useDrawingSession((s) => s.tool); const mode = useDrawingSession((s) => s.mode); const pinned = useDrawingSession((s) => s.pinnedTool);
  const prefs = useUiStore((s) => s.prefs.drawing); const cellId = useSelectionStore((s) => s.activeCell);
  const keys = useActionKeys();
  const pinnedRun = useRef<HTMLDivElement>(null);
  const pinnedTools = prefs.pinnedTools.flatMap((id) => toolOf(id) ?? []);
  const shownPins = usePinnedRoom(pinnedRun, pinnedTools.length);
  const [lastTools, setLastTools] = useState<Partial<Record<Tool["group"], Tool>>>({});
  useEffect(() => { const tool = active && toolOf(active); if (tool) setLastTools((s) => ({ ...s, [tool.group]: tool })); }, [active]);
  const setTool = (tool: Tool) => { useDrawingSession.getState().setTool(cellId, tool.tool); surfaceFor(cellId)?.focus(); };
  const setPrefs = useUiStore.getState().setDrawingPrefs;
  const action = (f: () => void) => { f(); surfaceFor(cellId)?.focus(); };
  const pinnedButton = (tool: Tool, press?: GroupPress) => <button key={tool.tool} className="draw-tool" data-active-tool aria-label={`${tool.label} 고정 도구`} title={toolTitle(tool, keys, "고정")} aria-pressed={active === tool.tool} onClick={() => setTool(tool)} onDoubleClick={() => action(() => useDrawingSession.getState().setTool(cellId, tool.tool, true))} {...press}><Icon path={tool.icon} /></button>;
  const folded = pinnedTools.slice(shownPins);
  return <nav data-chart-control aria-label="드로잉 도구" className="drawing-toolbar ui-island max-md:hidden">
    <button className="draw-tool" data-active-tool aria-label="선택 도구" title={keyTitle("선택", keys, "select")} aria-pressed={active === null && mode === null} onClick={() => action(() => useDrawingSession.getState().setTool(cellId, null))}><Icon path={DRAWING_ICONS.pointer} /></button>
    {[...toolsByGroup()].map(([group, tools]) => {
      const t = tools.find((tool) => tool.tool === active) ?? lastTools[group] ?? tools[0]!;
      const groupButton = (press?: GroupPress) => <button className="draw-tool" data-active-tool title={toolTitle(t, keys, pinned === t.tool ? "연속" : undefined)} aria-label={t.label} aria-pressed={active === t.tool} onClick={() => setTool(t)} onDoubleClick={() => action(() => useDrawingSession.getState().setTool(cellId, t.tool, true))} {...press}><Icon path={t.icon} /></button>;
      return tools.length > 1
        ? <ToolGroup key={group} label={`${GROUP_LABEL[group]} 도구`} tools={tools} keys={keys} onChoose={setTool}>{groupButton}</ToolGroup>
        : <div className="draw-group" key={group}>{groupButton()}</div>;
    })}
    <div ref={pinnedRun} className="draw-pinned">
      {pinnedTools.length > 0 && pinnedTools.slice(0, shownPins - 1).map((tool) => pinnedButton(tool))}
      {pinnedTools.length > 0 && (folded.length > 0
        ? <ToolGroup label="고정 도구" tools={folded} keys={keys} onChoose={setTool} pinnable={false}>{(press) => pinnedButton(pinnedTools[shownPins - 1]!, press)}</ToolGroup>
        : pinnedButton(pinnedTools[shownPins - 1]!))}
    </div>
    <div className="draw-separator" />
    {MODES.filter((m) => m.id !== "demo").map((m) => <button key={m.id} className="draw-tool" data-active-tool aria-label={m.label} title={m.label} aria-pressed={mode === m.id} onClick={() => action(() => useDrawingSession.setState({ tool: null, mode: mode === m.id ? null : m.id }))}><Icon path={m.icon} /></button>)}
    <MagnetButton action={action} keys={keys} />
    <button className="draw-tool" aria-label="연속 그리기" title="연속 그리기" aria-pressed={prefs.keepDrawing} onClick={() => action(() => setPrefs({ keepDrawing: !prefs.keepDrawing }))}><Icon path={DRAWING_ICONS.keepDrawing} /></button>
    <div className="draw-toolbar-end">
      <button ref={helpAnchor} className="draw-tool" aria-label="드로잉 단축키 도움말" title="드로잉 단축키" onClick={() => setHelp(!help)}>?</button>
      <button className="draw-tool" aria-label="드로잉 도구 막대 숨기기" title="드로잉 도구 막대 숨기기" onClick={() => action(() => setToolbarHidden(true))}><span aria-hidden="true">«</span></button>
    </div>
    {helpDialog}
  </nav>;
}

const LONG_PRESS_MS = 300;

interface GroupPress {
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  onContextMenu(e: React.MouseEvent): void;
  onPointerDown(e: PointerEvent): void;
  onPointerUp(): void;
  onPointerCancel(): void;
  onPointerLeave(): void;
  onKeyDown(e: React.KeyboardEvent): void;
  onClickCapture(e: React.MouseEvent): void;
}

function ToolGroup({ label, tools, keys, onChoose, pinnable = true, children }: { label: string; tools: readonly Tool[]; keys: ActionKeys; onChoose(tool: Tool): void; pinnable?: boolean; children(press: GroupPress): ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pinned = useUiStore((s) => s.prefs.drawing.pinnedTools);
  const typed = useRef({ text: "", at: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => clear, []);
  const besideRail = () => {
    const own = wrapper.current?.getBoundingClientRect();
    const rail = wrapper.current?.closest("nav")?.getBoundingClientRect();
    return own && rail ? { left: rail.left, right: rail.right, top: own.top, bottom: own.bottom } : own;
  };
  const press: GroupPress = {
    "aria-haspopup": "menu", "aria-expanded": open,
    onContextMenu: (e) => { e.preventDefault(); clear(); held.current = false; setOpen(true); },
    onPointerDown: (e) => { if (e.button !== 0) return; held.current = false; clear(); timer.current = setTimeout(() => { held.current = true; setOpen(true); }, LONG_PRESS_MS); },
    onPointerUp: clear, onPointerCancel: clear, onPointerLeave: clear,
    onKeyDown: (e) => { if (e.key === "ArrowRight" && !e.nativeEvent.isComposing) { e.preventDefault(); setOpen(true); } },
    onClickCapture: (e) => { if (held.current) { held.current = false; e.preventDefault(); e.stopPropagation(); } },
  };
  return <div className="draw-group" ref={wrapper}>{children(press)}<div className="draw-group-toggle"><button ref={trigger} type="button" aria-label={`${label} 펼치기`} title={label} aria-haspopup="menu" aria-expanded={open} className="draw-group-dot" onClick={() => setOpen(!open)}><svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="2" fill="currentColor" /></svg></button>
    {open && <Popover data-chart-control anchor={trigger} anchorRect={besideRail} follow placement="right" role="menu" aria-label={label} className="draw-tool-menu" onClose={() => setOpen(false)} onKeyDown={(e) => {
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
        <button type="button" role="menuitem" onClick={() => { onChoose(tool); setOpen(false); }}><Icon path={tool.icon} size={16} /><span>{tool.label}</span>{shortcutOf(keys, toolActionId(tool.tool)) && <kbd>{shortcutOf(keys, toolActionId(tool.tool))}</kbd>}</button>
        {pinnable && <button type="button" role="menuitemcheckbox" aria-label={`${tool.label} 막대에 고정`} aria-checked={pinned.includes(tool.tool)} title="막대에 고정" onClick={() => useUiStore.getState().setDrawingPrefs({ pinnedTools: pinned.includes(tool.tool) ? pinned.filter((id) => id !== tool.tool) : [...pinned, tool.tool] })}><StarIcon size={16} /></button>}
      </div>)}
    </Popover>}
  </div></div>;
}

function DrawingHelp({ anchor, close }: { anchor: React.RefObject<HTMLButtonElement | null>; close(): void }) {
  const keys = useActionKeys();
  const shortcuts = [...toolsByGroup().values()].flat().flatMap((tool) => { const shortcut = allShortcutsOf(keys, toolActionId(tool.tool)); return shortcut ? [{ tool, shortcut }] : []; });
  return <Popover anchor={anchor} follow placement="right" onClose={close} className="drawing-help" role="dialog" aria-label="드로잉 단축키">
    <div className="draw-dialog-head"><strong>드로잉 단축키</strong><button className="icon-btn" aria-label="도움말 닫기" onClick={close}><CloseIcon /></button></div>
    <section className="draw-help-tools" aria-label="도구 단축키"><h3>도구</h3><div>{shortcuts.map(({ tool, shortcut }) => <p key={tool.tool}><span>{tool.label}</span><kbd>{shortcut}</kbd></p>)}</div></section>
    <div className="draw-help-sections">{gestureSections(registeredModes()).map((section) => <section key={section.title} aria-label={section.title}><h3>{section.title}</h3>{section.rows.map((h) => <p key={h.keys}><kbd>{h.keys}</kbd><span>{h.label}</span></p>)}</section>)}</div>
  </Popover>;
}
function MagnetButton({ action, keys }: { action(f: () => void): void; keys: ActionKeys }) {
  const prefs = useUiStore((s) => s.prefs.drawing);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => clear, []);
  return <div ref={root}>
    <button className="draw-tool" aria-label="자석" title={`${keyTitle("자석 켜기/끄기", keys, "magnet")}, ${keyTitle("세기 바꾸기", keys, "magnetStrength")} · 우클릭 또는 길게 누르기`} aria-pressed={prefs.magnet} aria-haspopup="menu" aria-expanded={open}
      onContextMenu={(e) => { e.preventDefault(); held.current = true; setOpen(true); }}
      onPointerDown={(e) => { if (e.button !== 0) return; held.current = false; timer.current = setTimeout(() => { held.current = true; setOpen(true); }, 500); }}
      onPointerUp={clear} onPointerCancel={clear} onPointerLeave={clear}
      onClick={() => { if (!held.current) action(() => useUiStore.getState().setDrawingPrefs({ magnet: !prefs.magnet })); held.current = false; }}><Icon path={DRAWING_ICONS.magnet} /></button>
    {open && <Menu label="자석 세기" root={root} placement="right" onClose={() => setOpen(false)} items={[
      { kind: "radio", label: "약", checked: prefs.magnetStrength === "weak", onSelect: () => useUiStore.getState().setDrawingPrefs({ magnetStrength: "weak" }) },
      { kind: "radio", label: "강", checked: prefs.magnetStrength === "strong", onSelect: () => useUiStore.getState().setDrawingPrefs({ magnetStrength: "strong" }) },
    ]} />}
  </div>;
}
