import type { Logical } from "lightweight-charts";
import { formatPrice } from "../../lib/format";
import { isTypingTarget } from "../../lib/hotkeys";
import { DESKTOP_QUERY } from "../../lib/media";
import { isIndexCode } from "../../lib/symbol";
import { useDrawingSession } from "../../stores/drawingSession";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import type { ChartExtension, ChartHost } from "../extensions";
import { chartTimeProjection } from "../timeAxis";
import { formatBarTime } from "../time";
import { barLength, fromScreen, logicalToT, startAt, tToLogical, timelineOf, toolContext, xToLogical, type Frame } from "./anchor";
import * as clipboard from "./clipboard";
import { DrawingLayer, VLinePaneLayer } from "./DrawingLayer";
import { frameHit, renderItem, visible, type RenderFrame } from "./frame";
import { idsInBox, nudge, shapeBounds, type NudgeKey } from "./geometry";
import { holds, resolvePress, type DragAction, type Mods } from "./gestures";
import { toolHotkey } from "./hotkeys";
import { captures, IDLE, step, type Context, type Effect, type Input, type Interaction } from "./interaction";
import { effectiveMagnet, ohlcSource, snap } from "./magnet";
import type { DrawingSync } from "./sync";
import type { Shape } from "./toolSpec";
import { toolOf } from "./tools";
import type { DrawingBody, DrawingOp, DrawingScope, ScreenPoint } from "./types";
import { modeOf, registeredModes, type ModeContext, type TransientShapes } from "./modes";

const surfaces = new Map<number, DrawingSurface>();
export const surfaceFor = (slot: number) => surfaces.get(slot);
const modsOf = (e: MouseEvent | KeyboardEvent): Mods => ({ ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey });
const toast = (text: string) => useSelectionStore.getState().showToast(text);

export class DrawingSurface implements ChartExtension {
  private state: Interaction = IDLE;
  private layer: DrawingLayer;
  private cleanup: (() => void)[] = [];
  private pointer: number | null = null;
  private scroll: { handleScroll: ReturnType<ChartHost["chart"]["options"]>["handleScroll"]; handleScale: ReturnType<ChartHost["chart"]["options"]>["handleScale"] } | null = null;
  private mirror = document.createElement("div");
  private raf: number | null = null;
  private paneLayers: (() => void)[] = [];
  private transient: (TransientShapes & { createdAt: number }) | null = null;

  constructor(readonly host: ChartHost, readonly slot: number, readonly sync: DrawingSync) {
    this.mirror.className = "drawing-mirror"; this.mirror.setAttribute("aria-hidden", "true"); this.mirror.hidden = true;
    host.el.append(this.mirror);
    this.layer = new DrawingLayer(() => this.build());
    host.series().attachPrimitive(this.layer);
    this.attachPanes();
    surfaces.set(slot, this);
    const on = <K extends keyof HTMLElementEventMap>(name: K, handler: (e: HTMLElementEventMap[K]) => void) => {
      host.el.addEventListener(name, handler, { capture: true });
      this.cleanup.push(() => host.el.removeEventListener(name, handler, { capture: true }));
    };
    on("pointerdown", (e) => this.onPointer(e, "down"));
    on("pointermove", (e) => this.onPointer(e, "move"));
    on("pointerup", (e) => this.onPointer(e, "up"));
    on("pointercancel", () => this.reset());
    on("lostpointercapture", () => { if (this.pointer !== null) this.reset(); });
    on("contextmenu", (e) => this.contextMenu(e));
    on("dblclick", (e) => {
      if (this.state.kind === "placing") { e.preventDefault(); e.stopImmediatePropagation(); this.input({ kind: "finish" }); return; }
      const hit = frameHit(this.frame(), this.local(e));
      if (hit.kind !== "empty") { e.preventDefault(); e.stopImmediatePropagation(); this.openEditor(hit.id); }
    });
    const key = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener("keydown", key, true);
    const blur = () => this.reset(); window.addEventListener("blur", blur);
    this.cleanup.push(() => window.removeEventListener("keydown", key, true), () => window.removeEventListener("blur", blur));
    this.cleanup.push(sync.subscribe(() => this.refresh()));
    this.cleanup.push(useDrawingSession.subscribe((s, old) => { if (s.tool !== old.tool || s.mode !== old.mode) this.reset(); this.refresh(); }));
    this.cleanup.push(useUiStore.subscribe(() => this.refresh()));
    const media = matchMedia(DESKTOP_QUERY); const resize = () => { this.reset(); this.refresh(); };
    media.addEventListener("change", resize); this.cleanup.push(() => media.removeEventListener("change", resize));
    const observer = new MutationObserver(() => this.refresh()); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    this.cleanup.push(() => observer.disconnect());
  }

  reattach() { this.host.series().attachPrimitive(this.layer); this.attachPanes(); this.refresh(); }
  private attachPanes() {
    this.paneLayers.forEach((f) => f()); this.paneLayers = [];
    for (const pane of this.host.chart.panes().slice(1)) {
      const primitive = new VLinePaneLayer(() => this.layer.current().items.flatMap((item) => item.shapes.filter((shape): shape is Extract<Shape, { kind: "vline" }> => shape.kind === "vline")), () => pane.getHeight());
      pane.attachPrimitive(primitive); this.paneLayers.push(() => pane.detachPrimitive(primitive));
    }
  }
  dispose() {
    this.reset(); this.cleanup.forEach((f) => f()); this.paneLayers.forEach((f) => f());
    this.host.series().detachPrimitive(this.layer); this.mirror.remove();
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    if (surfaces.get(this.slot) === this) surfaces.delete(this.slot);
  }
  focus() { this.host.el.parentElement?.focus({ preventScroll: true }); }
  reset() { this.state = IDLE; this.release(); this.refresh(); }
  refresh() {
    if (this.raf !== null) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.layer.refresh(); if (this.transient) this.refresh(); });
  }
  frame() { return this.layer.current(); }
  projection(): Frame {
    const h = this.host; const ts = h.chart.timeScale(); const view = h.view(); const period = view?.period ?? "D";
    const bars = h.bars();
    return { timeline: timelineOf(bars, period), bars, logScale: view?.settings.scale === "log",
      pane: { width: ts.width(), height: h.chart.panes()[0]?.getHeight() ?? h.el.clientHeight },
      axes: { time: { coordinateOf: (i) => ts.logicalToCoordinate(i as Logical), indexAt: (x) => ts.coordinateToLogical(x), barSpacing: ts.options().barSpacing, projection: chartTimeProjection(ts, period) },
        price: { toY: (p) => h.series().priceToCoordinate(p), toPrice: (y) => h.series().coordinateToPrice(y) } } };
  }
  private context(frame = this.projection()): Context {
    const session = useDrawingSession.getState(); const prefs = useUiStore.getState().prefs.drawing;
    const view = this.host.view();
    const ctx = toolContext(frame, { price: (p) => formatPrice(p, isIndexCode(view?.symbol ?? "")), time: (t) => formatBarTime(t, frame.timeline.period) });
    return { tool: session.tool === null ? null : toolOf(session.tool) ?? null, selected: session.selected,
      drawings: view ? this.sync.drawings(view.symbol) : [], lockAll: prefs.lockAll, registeredModes: registeredModes(), mode: session.mode, ctx,
      point: (at, action, mods) => this.point(frame, at, action, mods) };
  }
  private point(frame: Frame, at: ScreenPoint, action: DragAction, mods: Mods) {
    const raw = fromScreen(frame, at);
    if (!raw) return null;
    const logical = tToLogical(frame.timeline, raw.t);
    if (logical === null) return raw;
    const start = startAt(frame.timeline, Math.floor(logical));
    if (start !== null && start > raw.t) return raw;
    if (start !== null && raw.t >= start + barLength(frame.timeline.period, start)) return raw;
    const prefs = useUiStore.getState().prefs.drawing;
    const snapped = snap({ logical, price: raw.price, y: at.y }, effectiveMagnet({ on: prefs.magnet, strength: prefs.magnetStrength }, holds(action, mods).has("invertMagnet")), [ohlcSource(frame.bars)], frame.axes.price);
    const t = logicalToT(frame.timeline, snapped.logical);
    return t === null ? null : { t, price: snapped.price };
  }
  private build(): RenderFrame {
    const f = this.projection(); const c = this.context(f); const view = this.host.view();
    const session = useDrawingSession.getState(); const prefs = useUiStore.getState().prefs.drawing;
    const editable = matchMedia(DESKTOP_QUERY).matches;
    const layoutId = useLayoutStore.getState().layout.id;
    let drawings = c.drawings;
    if (this.state.kind === "dragging") {
      const preview = this.state.preview;
      drawings = this.state.action === "clone" ? [...drawings, ...preview.map((d) => ({ ...d, id: `${d.id}:preview` }))]
        : drawings.map((d) => preview.find((p) => p.id === d.id) ?? d);
    }
    if (session.editor && session.editor.draft.symbol === view?.symbol) drawings = drawings.map((d) => d.id === session.editor?.draft.id ? session.editor.draft : d);
    const items = drawings.filter((d) => visible(d, { layoutId, slot: this.slot, period: view?.period ?? "D", hideAll: prefs.hideAll }))
      .map((d) => renderItem(d, editable && session.selected.includes(d.id), c.ctx)).filter((item) => item !== null);
    const preview: Shape[] = [];
    if (this.state.kind === "placing" || this.state.kind === "drawing") {
      const s = this.state;
      const points = s.kind === "placing" ? [...s.fixed, s.cursor] : s.points.length === 1 ? [s.points[0]!, s.points[0]!] : s.points;
      preview.push(...s.tool.shapes({ points, style: prefs.lastStyle[s.tool.tool] ?? s.tool.defaultStyle(), text: null, selected: false }, c.ctx));
      for (const p of s.kind === "placing" ? s.fixed : s.points) {
        const screen = c.ctx.toScreen(p); if (screen) preview.push({ kind: "circle", c: screen, r: 4, stroke: { color: "$draw", width: 1, dash: "solid" }, fill: { on: true, color: "$chart-bg", opacity: 1 } });
      }
    }
    if (this.state.kind === "mode") preview.push(...(modeOf(this.state.mode)?.preview(this.state.path, this.modeContext({ items, ctx: c.ctx })) ?? []));
    let transient: RenderFrame["transient"];
    if (this.transient) {
      const elapsed = performance.now() - this.transient.createdAt - this.transient.holdMs;
      if (elapsed >= this.transient.fadeMs) this.transient = null;
      else transient = { shapes: this.transient.shapes, opacity: Math.max(0, 1 - Math.max(0, elapsed) / Math.max(1, this.transient.fadeMs)) };
    }
    this.mirror.dataset.drawings = JSON.stringify(items.map((i) => ({ id: i.id, tool: i.drawing.tool, selected: session.selected.includes(i.id), points: i.drawing.points.map(c.ctx.toScreen), handles: i.handles })));
    return { items, preview, transient, box: this.state.kind === "box" ? this.state : null, pane: f.pane, ctx: c.ctx, editable };
  }

  private local(e: MouseEvent): ScreenPoint { const r = this.host.el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  private onPointer(e: PointerEvent, kind: "down" | "move" | "up") {
    if (!matchMedia(DESKTOP_QUERY).matches || (kind === "down" && e.button !== 0) || useDrawingSession.getState().editor) return;
    if (this.pointer !== null && this.pointer !== e.pointerId) return;
    const at = this.local(e); const frame = this.frame();
    if (kind === "down" && (at.x < 0 || at.y < 0 || at.x >= frame.pane.width || at.y >= frame.pane.height)) return;
    if (kind === "down") { this.focus(); useDrawingSession.setState({ popup: null }); }
    const hit = frameHit(frame, at);
    const wasCaptured = captures(this.state);
    if (kind === "down") {
      const c = this.context(); const resolution = resolvePress(c.tool ? "draw" : c.mode === "eraser" ? "erase" : "select", hit.kind, modsOf(e), c.registeredModes);
      if (resolution?.capturesPointer) this.capture(e.pointerId);
    }
    const capturedHere = this.pointer !== null;
    this.input(kind === "down" ? { kind, at, mods: modsOf(e), hit } : { kind, at, mods: modsOf(e) });
    if (wasCaptured || capturedHere || captures(this.state) || this.pointer !== null) { e.preventDefault(); e.stopImmediatePropagation(); }
    if (kind === "up") this.release();
    if (kind === "move") this.host.el.style.cursor = captures(this.state) ? "grabbing" : useDrawingSession.getState().tool ? "crosshair" : hit.kind === "handle" ? "grab" : hit.kind === "body" ? "move" : "";
  }
  private capture(id: number) {
    this.pointer = id; this.host.el.setPointerCapture(id);
    if (this.scroll === null) { const { handleScale, handleScroll } = this.host.chart.options(); this.scroll = structuredClone({ handleScale, handleScroll }); }
    this.host.chart.applyOptions({ handleScroll: false, handleScale: false });
  }
  private release() {
    const id = this.pointer; this.pointer = null;
    if (id !== null && this.host.el.hasPointerCapture(id)) this.host.el.releasePointerCapture(id);
    if (this.scroll !== null) { this.host.chart.applyOptions(this.scroll); this.scroll = null; }
    this.host.el.style.cursor = "";
  }
  private input(e: Input) {
    const transition = step(this.state, e, this.context()); this.state = transition.state;
    for (const effect of transition.effects) this.effect(effect);
    this.refresh();
  }
  private effect(effect: Effect) {
    const session = useDrawingSession.getState();
    switch (effect.kind) {
      case "select": session.select(effect.ids, effect.toggle); break;
      case "place": {
        const view = this.host.view(); if (!view) break;
        const prefs = useUiStore.getState().prefs.drawing;
        const body: DrawingBody = { id: crypto.randomUUID(), symbol: view.symbol, tool: effect.tool.tool, points: effect.points,
          style: prefs.lastStyle[effect.tool.tool] ?? effect.tool.defaultStyle(), text: null, locked: false, hidden: false,
          z: Math.max(0, ...this.sync.drawings(view.symbol).map((d) => d.z)) + 1, periods: null, scope: this.newScope(), group: null, revision: 0 };
        if (prefs.hideAll) useUiStore.getState().setDrawingPrefs({ hideAll: false });
        this.sync.commit(this.slot, [{ kind: "create", after: body }]);
        if (!prefs.keepDrawing && session.pinnedTool !== body.tool) session.setTool(null);
        session.select([body.id]);
        if (effect.tool.text?.editOnPlace) this.openEditor(body.id, "text");
        break;
      }
      case "change": {
        if (effect.clone) this.commitClones(effect.preview);
        else { const ops: DrawingOp[] = effect.preview.flatMap((after) => { const before = effect.originals.find((d) => d.id === after.id); return before ? [{ kind: "update" as const, before, after }] : []; }); this.sync.commit(this.slot, ops); session.select(effect.preview.map((d) => d.id)); }
        break;
      }
      case "box": { const f = this.frame(); session.select(idsInBox(f.items, effect.start, effect.end, f.pane)); break; }
      case "mode": {
        const result = modeOf(effect.mode)?.finish(effect.path, effect.action === "erasePartial", this.modeContext(this.frame()));
        if (result) { this.sync.commit(this.slot, result.ops); if (result.transient) this.transient = { ...result.transient, createdAt: performance.now() }; }
        if (effect.mode === "eraser" && !useUiStore.getState().prefs.drawing.keepDrawing) useDrawingSession.setState({ mode: null });
        break;
      }
    }
  }
  private modeContext(frame: Pick<RenderFrame, "items" | "ctx">): ModeContext {
    return { ...frame, lockAll: useUiStore.getState().prefs.drawing.lockAll, scope: this.newScope(), newId: () => crypto.randomUUID() };
  }
  newScope(): DrawingScope {
    const kind = useUiStore.getState().prefs.drawing.newScope; const layoutId = useLayoutStore.getState().layout.id;
    return kind === "symbol" ? { kind } : kind === "layout" ? { kind, layoutId } : { kind, layoutId, slot: this.slot === 1 || this.slot === 2 || this.slot === 3 ? this.slot : 0 };
  }
  selected() {
    const symbol = this.host.view()?.symbol; const ids = useDrawingSession.getState().selected;
    return symbol ? this.sync.drawings(symbol).filter((d) => ids.includes(d.id)) : [];
  }
  updateSelected(change: (d: DrawingBody) => DrawingBody) {
    const ops = this.selected().map((before) => ({ kind: "update" as const, before, after: change(before) }));
    this.sync.commit(this.slot, ops);
    const changed = ops.filter((op) => op.after.style !== op.before.style);
    if (changed.length) {
      const ui = useUiStore.getState(); const lastStyle = { ...ui.prefs.drawing.lastStyle };
      for (const op of changed) lastStyle[op.after.tool] = op.after.style;
      ui.setDrawingPrefs({ lastStyle });
    }
  }
  copy() { const symbol = this.host.view()?.symbol; if (symbol) useDrawingSession.setState({ clip: clipboard.copy(this.selected(), symbol) }); }
  paste() {
    const session = useDrawingSession.getState(); const view = this.host.view(); if (!view || !session.clip) return;
    const ctx = this.context().ctx;
    const result = clipboard.paste(session.clip, { symbol: view.symbol, topZ: Math.max(0, ...this.sync.drawings(view.symbol).map((d) => d.z)), scope: this.newScope(), newId: () => crypto.randomUUID(), shiftBars: ctx.shiftBars });
    this.sync.commit(this.slot, result.bodies.map((after) => ({ kind: "create", after })));
    useDrawingSession.setState({ clip: result.clip }); session.select(result.bodies.map((d) => d.id));
    if (result.bodies.some((d) => d.points.some((p) => { const s = ctx.toScreen(p); return s === null || s.y < 0 || s.y > ctx.paneHeight; }))) toast("보이는 범위 밖에 붙였습니다");
  }
  clone() {
    const ctx = this.context().ctx;
    this.commitClones(this.selected().map((d) => ({ ...d, points: d.points.map((p) => ({ ...p, t: ctx.shiftBars(p.t, 5) ?? p.t })) })));
  }
  private commitClones(drawings: readonly DrawingBody[]) {
    const symbol = this.host.view()?.symbol; if (!symbol) return;
    const z = Math.max(0, ...this.sync.drawings(symbol).map((d) => d.z));
    const clones = drawings.map((d, i) => ({ ...d, id: crypto.randomUUID(), locked: false, group: null, scope: this.newScope(), z: z + i + 1, revision: 0 }));
    this.sync.commit(this.slot, clones.map((after) => ({ kind: "create", after }))); useDrawingSession.getState().select(clones.map((d) => d.id));
  }
  remove(force = false) {
    const prefs = useUiStore.getState().prefs.drawing; const selected = this.selected();
    this.sync.commit(this.slot, selected.filter((d) => force || (!d.locked && !prefs.lockAll)).map((before) => ({ kind: "delete", before })));
    useDrawingSession.getState().select([]);
    if (selected.length) useSelectionStore.getState().showToast("드로잉을 지웠습니다", () => this.sync.undo(this.slot, false));
  }
  openEditor(id: string, kind: "settings" | "text" = "settings") {
    const symbol = this.host.view()?.symbol; const d = symbol ? this.sync.drawings(symbol).find((item) => item.id === id) : undefined;
    if (!d) return;
    const tool = toolOf(d.tool); const nextKind = kind === "text" || tool?.text?.editOnPlace ? "text" : "settings";
    useDrawingSession.setState({ editor: { kind: nextKind, original: d, draft: d }, popup: null });
  }
  reorder(id: string, direction: "front" | "forward" | "backward" | "back", targetId?: string, dropPosition: "above" | "below" = "below") {
    const symbol = this.host.view()?.symbol; if (!symbol) return;
    const all = this.sync.drawings(symbol); const current = all.find((d) => d.id === id); if (!current) return;
    const rest = all.filter((d) => d.id !== id);
    const index = targetId ? rest.findIndex((d) => d.id === targetId) + (dropPosition === "above" ? 1 : 0) : direction === "front" ? rest.length : direction === "back" ? 0 : Math.max(0, Math.min(rest.length, all.indexOf(current) + (direction === "forward" ? 1 : -1)));
    const lo = rest[index - 1]?.z; const hi = rest[index]?.z;
    const z = lo === undefined ? (hi ?? 1) - 1 : hi === undefined ? lo + 1 : (lo + hi) / 2;
    if (lo !== undefined && hi !== undefined && hi - lo < 1e-9) {
      rest.splice(index, 0, current); this.sync.commit(this.slot, rest.map((d, i) => ({ kind: "update", before: d, after: { ...d, z: i + 1 } })));
    } else this.sync.commit(this.slot, [{ kind: "update", before: current, after: { ...current, z } }]);
  }
  reveal(id: string) {
    const symbol = this.host.view()?.symbol; if (!symbol) return;
    const d = this.sync.drawings(symbol).find((item) => item.id === id); if (!d || d.hidden) return;
    const ctx = this.context().ctx; const point = d.points[0]; const screen = point ? ctx.toScreen(point) : null;
    if (screen && (screen.x < 0 || screen.x > ctx.paneWidth)) {
      const f = this.projection(); const logical = point ? xToLogical(f.axes.time, screen.x) : null;
      const range = this.host.chart.timeScale().getVisibleLogicalRange();
      if (logical !== null && range) { const half = (range.to - range.from) / 2; this.host.chart.timeScale().setVisibleLogicalRange({ from: logical - half, to: logical + half }); }
    }
    this.focus();
  }
  selectionBounds() {
    const frame = this.frame(); const boxes = frame.items.filter((i) => useDrawingSession.getState().selected.includes(i.id)).flatMap((i) => i.shapes.map((s) => shapeBounds(s, frame.pane)));
    return boxes.length ? { x1: Math.min(...boxes.map((b) => b.x1)), x2: Math.max(...boxes.map((b) => b.x2)), y1: Math.min(...boxes.map((b) => b.y1)), y2: Math.max(...boxes.map((b) => b.y2)) } : null;
  }
  private contextMenu(e: MouseEvent) {
    if (!matchMedia(DESKTOP_QUERY).matches) return;
    e.preventDefault(); e.stopImmediatePropagation(); this.reset(); this.focus();
    const hit = frameHit(this.frame(), this.local(e)); const id = hit.kind === "empty" ? null : hit.id;
    const session = useDrawingSession.getState(); if (id && !session.selected.includes(id)) session.select([id]);
    useDrawingSession.setState({ popup: { slot: this.slot, x: e.clientX, y: e.clientY, id } });
  }
  private onKey(e: KeyboardEvent) {
    if (!matchMedia(DESKTOP_QUERY).matches || isTypingTarget(e.target) || e.isComposing || useDrawingSession.getState().editor || useSelectionStore.getState().dialog) return;
    if (!this.host.el.parentElement?.contains(document.activeElement)) return;
    const session = useDrawingSession.getState(); const ui = useUiStore.getState(); const prefs = ui.prefs.drawing;
    const ctrl = e.ctrlKey || e.metaKey;
    const tool = toolHotkey(e);
    let handled = true;
    if (tool) { if (toolOf(tool.tool)) session.setTool(tool.tool); }
    else if (e.code === "KeyV" && !ctrl && !e.altKey && !e.shiftKey) session.setTool(null);
    else if (e.code === "KeyG" && !ctrl && !e.altKey) ui.setDrawingPrefs(e.shiftKey ? { magnetStrength: prefs.magnetStrength === "weak" ? "strong" : "weak" } : { magnet: !prefs.magnet });
    else if (e.code === "KeyH" && ctrl && e.altKey) ui.setDrawingPrefs({ hideAll: !prefs.hideAll });
    else if (e.code === "Escape") { this.input({ kind: "cancel" }); this.release(); session.setTool(null); session.select([]); useDrawingSession.setState({ popup: null }); }
    else if ((e.code === "Delete" || e.code === "Backspace") && session.selected.length) this.remove();
    else if (ctrl && e.code === "KeyC" && session.selected.length) this.copy();
    else if (ctrl && e.code === "KeyV" && session.clip) this.paste();
    else if (ctrl && (e.code === "KeyZ" || e.code === "KeyY")) this.sync.undo(this.slot, e.code === "KeyY" || e.shiftKey);
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.code) && session.selected.length) {
      const key = e.code as NudgeKey; const f = this.projection(); const ctx = this.context(f).ctx;
      this.sync.commit(this.slot, this.selected().filter((d) => !d.locked && !prefs.lockAll).flatMap((before) => {
        const points = nudge(before.points, key, { shiftBars: ctx.shiftBars, price: f.axes.price });
        return points ? [{ kind: "update" as const, before, after: { ...before, points } }] : [];
      }));
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); this.refresh(); }
  }
}
