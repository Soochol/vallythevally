import { ownsChartKeyboard } from "../../features/overlay/topLayer";
import type { Logical } from "lightweight-charts";
import { formatPrice } from "../../lib/format";
import { isTypingTarget } from "../../lib/typingTarget";
import { DESKTOP_QUERY } from "../../lib/media";
import { isIndexCode } from "../../lib/symbol";
import { cellDrawing, useDrawingSession } from "../../stores/drawingSession";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { currentActionKeys, useUiStore } from "../../stores/ui";
import type { ChartExtension, ChartHost } from "../extensions";
import { chartTimeProjection } from "../timeAxis";
import { formatBarTime } from "../time";
import { barLength, fromScreen, logicalToT, startAt, tToLogical, timelineOf, toolContext, type Frame } from "./anchor";
import { reusableStyle } from "./objects";
import { DrawingLayer, VLinePaneLayer } from "./DrawingLayer";
import { fineDemand, frameHit, placementPreview, renderItem, visible, type RenderFrame } from "./frame";
import * as clipboard from "./clipboard";
import { DrawingEdits, type ReorderDirection } from "./edits";
import { idsInBox, shapeBounds, type NudgeKey } from "./geometry";
import { holds, resolvePress, type DragAction, type Mods } from "./gestures";
import { matchDrawingHotkey, type DrawingHotkey } from "../../lib/hotkeys";
import { captures, IDLE, step, type Context, type Effect, type Input, type Interaction } from "./interaction";
import { effectiveMagnet, ohlcSource, snap } from "./magnet";
import type { DrawingSync } from "./sync";
import type { Shape, ToolContext } from "./toolSpec";
import { toolOf } from "./tools";
import type { DrawingBody, DrawingScope, ScreenPoint } from "./types";
import type { DrawingPoint } from "../../api/generated/DrawingPoint";
import { modeOf, registeredModes, type ModeContext, type TransientShapes } from "./modes";
import type { WindowId } from "../../layout/kinds";

const surfaces = new Map<WindowId, DrawingSurface>();
export const surfaceFor = (cellId: WindowId) => surfaces.get(cellId);
const modsOf = (e: MouseEvent | KeyboardEvent): Mods => ({ ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey });
const toast = (text: string) => useSelectionStore.getState().showToast(text);

export class DrawingSurface implements ChartExtension {
  private state: Interaction = IDLE;
  private layer: DrawingLayer;
  private cleanup: (() => void)[] = [];
  private pointer: number | null = null;
  private scroll: { handleScroll: ReturnType<ChartHost["chart"]["options"]>["handleScroll"]; handleScale: ReturnType<ChartHost["chart"]["options"]>["handleScale"] } | null = null;
  private mirror = document.createElement("div");
  private lastMirror = "";
  private editable = matchMedia(DESKTOP_QUERY).matches;
  private raf: number | null = null;
  private paneLayers: (() => void)[] = [];
  private transient: (TransientShapes & { createdAt: number }) | null = null;
  private readonly edits: DrawingEdits;
  private readonly frameListeners = new Set<() => void>();

  constructor(readonly host: ChartHost, readonly cellId: WindowId, readonly sync: DrawingSync) {
    this.edits = new DrawingEdits(sync, cellId, () => { const view = host.view(); return view ? { symbol: view.symbol, scope: this.newScope(), period: view.period } : null; });
    this.mirror.className = "drawing-mirror"; this.mirror.setAttribute("aria-hidden", "true"); this.mirror.hidden = true;
    host.el.append(this.mirror);
    this.layer = new DrawingLayer(() => this.build(), () => { for (const listener of this.frameListeners) listener(); });
    host.series().attachPrimitive(this.layer);
    this.attachPanes();
    surfaces.set(cellId, this);
    const on = <K extends keyof HTMLElementEventMap>(name: K, handler: (e: HTMLElementEventMap[K]) => void) => {
      const listener = (event: HTMLElementEventMap[K]) => {
        if (event.composedPath().some((target) => target instanceof Element && target.hasAttribute("data-chart-control"))) return;
        handler(event);
      };
      host.el.addEventListener(name, listener, { capture: true });
      this.cleanup.push(() => host.el.removeEventListener(name, listener, { capture: true }));
    };
    on("pointerdown", (e) => this.onPointer(e, "down"));
    on("pointermove", (e) => this.onPointer(e, "move"));
    on("pointerup", (e) => this.onPointer(e, "up"));
    on("pointercancel", () => this.reset());
    on("lostpointercapture", () => { if (this.pointer !== null) this.reset(); });
    on("contextmenu", (e) => this.contextMenu(e));
    on("dblclick", (e) => {
      const frame = this.frame(); const at = this.local(e);
      if (!this.inPane(frame, at)) return;
      if (this.state.kind === "placing") { e.preventDefault(); e.stopImmediatePropagation(); this.input({ kind: "finish" }); return; }
      const hit = frameHit(frame, at);
      if (hit.kind === "empty") return;
      e.preventDefault(); e.stopImmediatePropagation();
      const drawing = frame.items.find((item) => item.id === hit.id)?.drawing;
      this.openEditor(hit.id, drawing && toolOf(drawing.tool)?.text?.editOnPlace ? "text" : "settings");
    });
    const key = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener("keydown", key, true);
    const blur = () => this.reset(); window.addEventListener("blur", blur);
    this.cleanup.push(() => window.removeEventListener("keydown", key, true), () => window.removeEventListener("blur", blur));
    this.cleanup.push(sync.subscribe(() => this.refresh()));
    this.cleanup.push(host.fineBars.subscribe(() => this.refresh()));
    this.cleanup.push(useDrawingSession.subscribe((s, old) => { if (this.isActive() && (s.tool !== old.tool || s.mode !== old.mode)) this.reset(); this.refresh(); }));
    this.cleanup.push(useSelectionStore.subscribe((s, old) => { if (old.activeCell === this.cellId && s.activeCell !== this.cellId) this.reset(); }));
    this.cleanup.push(useUiStore.subscribe(() => this.refresh()));
    const media = matchMedia(DESKTOP_QUERY); const resize = () => { this.editable = media.matches; this.reset(); this.refresh(); };
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
    this.reset(); this.cleanup.forEach((f) => f()); this.paneLayers.forEach((f) => f()); this.host.fineBars.demand([]);
    this.host.series().detachPrimitive(this.layer); this.mirror.remove();
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    if (surfaces.get(this.cellId) === this) surfaces.delete(this.cellId);
  }
  focus() { this.host.el.parentElement?.focus({ preventScroll: true }); }
  reset() { this.state = IDLE; this.release(); this.refresh(); }
  refresh() {
    if (this.raf !== null) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.layer.refresh(); if (this.transient) this.refresh(); });
  }
  frame() { return this.layer.current(); }
  onFrame(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => { this.frameListeners.delete(listener); };
  }
  toolContext(): ToolContext { return this.frame().ctx ?? this.context().ctx; }
  projection(): Frame {
    const h = this.host; const ts = h.chart.timeScale(); const view = h.view(); const period = view?.period ?? "D";
    const bars = h.bars();
    return { timeline: timelineOf(bars, period), bars, logScale: view?.settings.scale === "log", fine: h.fineBars,
      pane: { width: ts.width(), height: h.chart.panes()[0]?.getHeight() ?? h.el.clientHeight },
      axes: { time: { coordinateOf: (i) => ts.logicalToCoordinate(i as Logical), indexAt: (x) => ts.coordinateToLogical(x), barSpacing: ts.options().barSpacing, projection: chartTimeProjection(ts, period) },
        price: { toY: (p) => h.series().priceToCoordinate(p), toPrice: (y) => h.series().coordinateToPrice(y) } } };
  }
  private isActive() { return useSelectionStore.getState().activeCell === this.cellId; }
  private cell() { return cellDrawing(useDrawingSession.getState(), this.cellId); }
  private liveTool() { const { tool, mode } = useDrawingSession.getState(); return this.isActive() ? { tool, mode } : { tool: null, mode: null }; }
  private context(frame = this.projection()): Context {
    const live = this.liveTool(); const prefs = useUiStore.getState().prefs.drawing;
    const view = this.host.view();
    const ctx = toolContext(frame, { price: (p) => formatPrice(p, isIndexCode(view?.symbol ?? "")), time: (t) => formatBarTime(t, frame.timeline.period) });
    return { tool: live.tool === null ? null : toolOf(live.tool) ?? null, selected: this.cell().selected,
      drawings: view ? this.sync.drawings(view.symbol) : [], lockAll: prefs.lockAll, registeredModes: registeredModes(), mode: live.mode, ctx,
      point: (at, action, mods) => this.point(frame, at, action, mods) };
  }
  private point(frame: Frame, at: ScreenPoint, action: DragAction, mods: Mods) {
    const raw = fromScreen(frame, at);
    if (!raw) return null;
    const logical = tToLogical(frame.timeline, raw.t);
    if (logical === null || logical < -0.5) return raw;
    const start = startAt(frame.timeline, Math.floor(logical));
    if (start !== null && start > raw.t) return raw;
    if (start !== null && raw.t >= start + barLength(frame.timeline.period, start)) return raw;
    const prefs = useUiStore.getState().prefs.drawing;
    const snapped = snap({ logical, price: raw.price, y: at.y }, effectiveMagnet({ on: prefs.magnet, strength: prefs.magnetStrength }, holds(action, mods).has("invertMagnet")), [ohlcSource(frame.bars)], frame.axes.price);
    const t = logicalToT(frame.timeline, snapped.logical);
    return t === null ? null : { t, price: snapped.price };
  }
  private setMirror(next: string) {
    if (this.lastMirror === next) return;
    this.lastMirror = next;
    this.mirror.dataset.drawings = next;
  }
  private build(): RenderFrame {
    const view = this.host.view();
    const cell = this.cell();
    const rawDrawings = view ? this.sync.drawings(view.symbol) : [];
    const hasEditor = cell.editor !== null && cell.editor.draft.symbol === view?.symbol;
    if (rawDrawings.length === 0 && this.state.kind === "idle" && !this.transient && !hasEditor) {
      this.host.fineBars.demand([]);
      this.setMirror("[]");
      const ts = this.host.chart.timeScale();
      return {
        items: [],
        preview: [],
        transient: undefined,
        box: null,
        pane: { width: ts.width(), height: this.host.chart.panes()[0]?.getHeight() ?? this.host.el.clientHeight },
        ctx: null,
        editable: this.editable,
      };
    }
    const f = this.projection(); const c = this.context(f);
    const prefs = useUiStore.getState().prefs.drawing;
    const editable = this.editable;
    const layoutId = useLayoutStore.getState().layout.id;
    const where = { layoutId, cellId: this.cellId, period: view?.period ?? "D", hideAll: prefs.hideAll };
    this.host.fineBars.demand(fineDemand(f, c.drawings.filter((d) => visible(d, where)), c.ctx));
    let drawings = c.drawings;
    if (this.state.kind === "dragging") {
      const preview = this.state.preview;
      drawings = this.state.action === "clone" ? [...drawings, ...preview.map((d) => ({ ...d, id: `${d.id}:preview` }))]
        : drawings.map((d) => preview.find((p) => p.id === d.id) ?? d);
    }
    if (hasEditor && cell.editor) drawings = drawings.map((d) => d.id === cell.editor?.draft.id ? cell.editor.draft : d);
    const items = drawings.filter((d) => visible(d, where))
      .map((d) => renderItem(d, editable && cell.selected.includes(d.id), c.ctx)).filter((item) => item !== null);
    const preview: Shape[] = [];
    if (this.state.kind === "placing" || this.state.kind === "drawing") preview.push(...placementPreview(this.state, prefs.lastStyle[this.state.tool.tool] ?? this.state.tool.defaultStyle(), c.ctx));
    if (this.state.kind === "mode") preview.push(...(modeOf(this.state.mode)?.preview(this.state.path, this.modeContext({ items, ctx: c.ctx })) ?? []));
    let transient: RenderFrame["transient"];
    if (this.transient) {
      const elapsed = performance.now() - this.transient.createdAt - this.transient.holdMs;
      if (elapsed >= this.transient.fadeMs) this.transient = null;
      else transient = { shapes: this.transient.shapes, opacity: Math.max(0, 1 - Math.max(0, elapsed) / Math.max(1, this.transient.fadeMs)) };
    }
    this.setMirror(JSON.stringify(items.map((i) => ({ id: i.id, tool: i.drawing.tool, selected: cell.selected.includes(i.id), points: i.drawing.points.map(c.ctx.toScreen), handles: i.handles, texts: i.shapes.flatMap((s) => (s.kind === "text" ? [s.text] : [])) }))));
    return { items, preview, transient, box: this.state.kind === "box" ? this.state : null, pane: f.pane, ctx: c.ctx, editable };
  }

  private inPane(frame: RenderFrame, at: ScreenPoint) { return at.x >= 0 && at.y >= 0 && at.x < frame.pane.width && at.y < frame.pane.height; }
  private local(e: MouseEvent): ScreenPoint { const r = this.host.el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  private setCursor(next: string) {
    if (this.host.el.style.cursor !== next) this.host.el.style.cursor = next;
  }
  private onPointer(e: PointerEvent, kind: "down" | "move" | "up") {
    if (!this.editable || (kind === "down" && e.button !== 0) || this.cell().editor) return;
    if (this.pointer !== null && this.pointer !== e.pointerId) return;
    if (kind === "move" && this.state.kind === "idle" && this.pointer === null) {
      const frame = this.frame();
      if (frame.items.length === 0) {
        const live = this.liveTool();
        this.setCursor(live.tool || live.mode === "eraser" ? "crosshair" : "");
        return;
      }
    }
    const at = this.local(e); const frame = this.frame();
    if (kind === "down" && !this.inPane(frame, at)) return;
    if (kind === "down") { this.focus(); useDrawingSession.getState().patchCell(this.cellId, { popup: null }); }
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
    if (kind === "move") {
      const live = this.liveTool(); const aiming = this.state.kind === "mode" || live.mode === "eraser";
      this.setCursor(captures(this.state) && !aiming ? "grabbing" : live.tool || aiming ? "crosshair" : hit.kind === "handle" ? "grab" : hit.kind === "body" ? "move" : "");
    }
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
    const previous = this.state;
    if (previous.kind === "idle" && e.kind !== "down") return;
    const transition = step(previous, e, this.context()); this.state = transition.state;
    for (const effect of transition.effects) this.effect(effect);
    if (transition.state !== previous || transition.effects.length > 0) this.refresh();
  }
  private effect(effect: Effect) {
    const session = useDrawingSession.getState();
    switch (effect.kind) {
      case "select": session.select(this.cellId, effect.ids, effect.toggle); break;
      case "place": {
        if (!this.host.view()) break;
        const prefs = useUiStore.getState().prefs.drawing;
        if (prefs.hideAll) useUiStore.getState().setDrawingPrefs({ hideAll: false });
        const body = this.edits.place(effect.tool, effect.points, prefs.lastStyle[effect.tool.tool] ?? effect.tool.defaultStyle());
        if (!body) break;
        if (!prefs.keepDrawing && session.pinnedTool !== body.tool) session.setTool(this.cellId, null);
        session.select(this.cellId, [body.id]);
        if (effect.tool.text?.editOnPlace) this.openEditor(body.id, "text");
        break;
      }
      case "change": {
        if (effect.clone) this.commitClones(effect.preview);
        else { this.edits.move(effect.preview, effect.originals); session.select(this.cellId, effect.preview.map((d) => d.id)); }
        break;
      }
      case "box": { const f = this.frame(); session.select(this.cellId, idsInBox(f.items, effect.start, effect.end, f.pane)); break; }
      case "mode": {
        const frame = this.frame();
        const result = modeOf(effect.mode)?.finish(effect.path, effect.action === "erasePartial", this.modeContext({ items: frame.items, ctx: this.toolContext() }));
        if (result) { this.sync.commit(this.cellId, result.ops); if (result.transient) this.transient = { ...result.transient, createdAt: performance.now() }; }
        if (effect.mode === "eraser" && !useUiStore.getState().prefs.drawing.keepDrawing) useDrawingSession.setState({ mode: null });
        break;
      }
    }
  }
  private modeContext(frame: { items: RenderFrame["items"]; ctx: ToolContext }): ModeContext {
    return { ...frame, lockAll: useUiStore.getState().prefs.drawing.lockAll, panesBottom: this.host.el.clientHeight - this.host.chart.timeScale().height(), scope: this.newScope(), newId: () => crypto.randomUUID() };
  }
  newScope(): DrawingScope {
    const kind = useUiStore.getState().prefs.drawing.newScope; const layoutId = useLayoutStore.getState().layout.id;
    return kind === "symbol" ? { kind } : kind === "layout" ? { kind, layoutId } : { kind, layoutId, windowId: this.cellId };
  }
  selected() { return this.edits.selected(this.cell().selected); }
  updateSelected(change: (d: DrawingBody) => DrawingBody) {
    const ops = this.edits.update(this.cell().selected, change);
    const changed = ops.filter((op) => op.after.style !== op.before.style);
    if (changed.length) {
      const ui = useUiStore.getState(); const lastStyle = { ...ui.prefs.drawing.lastStyle };
      for (const op of changed) lastStyle[op.after.tool] = reusableStyle(op.after.style);
      ui.setDrawingPrefs({ lastStyle });
    }
  }
  copy() { const symbol = this.host.view()?.symbol; if (symbol) useDrawingSession.setState({ clip: clipboard.copy(this.selected(), symbol) }); }
  paste() {
    const session = useDrawingSession.getState(); const view = this.host.view(); if (!view || !session.clip) return;
    const ctx = this.context().ctx;
    const result = this.edits.paste(session.clip, ctx.shiftBars); if (!result) return;
    useDrawingSession.setState({ clip: result.clip }); session.select(this.cellId, result.bodies.map((d) => d.id));
    if (result.bodies.some((d) => d.points.some((p) => { const s = ctx.toScreen(p); return s === null || s.y < 0 || s.y > ctx.paneHeight; }))) toast("보이는 범위 밖에 붙였습니다");
  }
  clone() {
    const ctx = this.context().ctx;
    this.commitClones(this.selected().map((d) => ({ ...d, points: d.points.map((p) => ({ ...p, t: ctx.shiftBars(p.t, 5) ?? p.t })) })));
  }
  private commitClones(drawings: readonly DrawingBody[]) {
    if (!this.host.view()) return;
    useDrawingSession.getState().select(this.cellId, this.edits.clone(drawings).map((d) => d.id));
  }
  remove(force = false) {
    this.edits.remove(this.cell().selected, { force, lockAll: useUiStore.getState().prefs.drawing.lockAll });
    useDrawingSession.getState().select(this.cellId, []);
  }
  openEditor(id: string, kind: "settings" | "text" = "settings") {
    const d = this.edits.find(id);
    if (!d) return;
    if (!this.frame().ctx) this.layer.refresh();
    const session = useDrawingSession.getState();
    session.select(this.cellId, [d.id]);
    session.patchCell(this.cellId, { editor: { kind, original: d, draft: d }, popup: null });
  }
  reorder(id: string, direction: ReorderDirection, targetId?: string, dropPosition: "above" | "below" = "below") { this.edits.reorder(id, direction, targetId, dropPosition); }
  selectionBounds() {
    const frame = this.frame(); const selected = this.cell().selected; const boxes = frame.items.filter((i) => selected.includes(i.id)).flatMap((i) => i.shapes.map((s) => shapeBounds(s, frame.pane)));
    return boxes.length ? { x1: Math.min(...boxes.map((b) => b.x1)), x2: Math.max(...boxes.map((b) => b.x2)), y1: Math.min(...boxes.map((b) => b.y1)), y2: Math.max(...boxes.map((b) => b.y2)) } : null;
  }
  pointAt(client: ScreenPoint): { price: number; t: DrawingPoint["t"] | null } | null {
    const r = this.host.el.getBoundingClientRect();
    const frame = this.projection();
    const onBar = fromScreen(frame, { x: client.x - r.left, y: client.y - r.top });
    if (onBar) return onBar;
    const price = frame.axes.price.toPrice(client.y - r.top);
    return price === null ? null : { price, t: null };
  }
  placeHorizontalLine(client: ScreenPoint) {
    const tool = toolOf("hline"); const point = this.pointAt(client); const t = point?.t ?? this.host.bars().at(-1)?.t;
    if (tool && point && t !== undefined) this.effect({ kind: "place", tool, points: [{ t, price: point.price }] });
  }
  fitPriceScale() { this.host.chart.priceScale("right").applyOptions({ autoScale: true }); }
  private keepsDrawing() { return useUiStore.getState().prefs.drawing.keepDrawing || useDrawingSession.getState().pinnedTool !== null; }
  private endDrawingRun() {
    const session = useDrawingSession.getState();
    this.input({ kind: "cancel" }); this.release(); session.setTool(this.cellId, null);
    if (useUiStore.getState().prefs.drawing.keepDrawing) useUiStore.getState().setDrawingPrefs({ keepDrawing: false });
    this.focus();
  }
  private contextMenu(e: MouseEvent) {
    if (!this.editable) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (this.keepsDrawing()) { this.endDrawingRun(); return; }
    this.reset(); this.focus();
    const hit = frameHit(this.frame(), this.local(e)); const id = hit.kind === "empty" ? null : hit.id;
    const session = useDrawingSession.getState(); if (id && !this.cell().selected.includes(id)) session.select(this.cellId, [id]);
    session.patchCell(this.cellId, { popup: { x: e.clientX, y: e.clientY, id, fromChart: true } });
  }
  private runHotkey(hotkey: DrawingHotkey) {
    const session = useDrawingSession.getState(); const ui = useUiStore.getState(); const prefs = ui.prefs.drawing;
    if (hotkey.kind === "tool") { if (toolOf(hotkey.tool)) session.setTool(this.cellId, hotkey.tool); }
    else if (hotkey.kind === "select") session.setTool(this.cellId, null);
    else if (hotkey.kind === "magnet") ui.setDrawingPrefs({ magnet: !prefs.magnet });
    else if (hotkey.kind === "magnetStrength") ui.setDrawingPrefs({ magnetStrength: prefs.magnetStrength === "weak" ? "strong" : "weak" });
    else ui.setDrawingPrefs({ hideAll: !prefs.hideAll });
  }
  private onKey(e: KeyboardEvent) {
    if (e.composedPath().some((target) => target instanceof Element && target.hasAttribute("data-chart-control"))) return;
    if (ownsChartKeyboard(e) || !this.editable || isTypingTarget(e.target) || e.isComposing || this.cell().editor || useSelectionStore.getState().dialog) return;
    if (!this.host.el.parentElement?.contains(document.activeElement)) return;
    const session = useDrawingSession.getState(); const selected = this.cell().selected; const ui = useUiStore.getState(); const prefs = ui.prefs.drawing;
    const ctrl = e.ctrlKey || e.metaKey;
    const hotkey = matchDrawingHotkey(e, currentActionKeys());
    let handled = true;
    if (hotkey) this.runHotkey(hotkey);
    else if (e.code === "Escape") this.endDrawingRun();
    else if ((e.code === "Delete" || e.code === "Backspace") && selected.length) this.remove();
    else if (ctrl && e.code === "KeyC" && selected.length) this.copy();
    else if (ctrl && e.code === "KeyV" && session.clip) this.paste();
    else if (ctrl && (e.code === "KeyZ" || e.code === "KeyY")) this.sync.undo(this.cellId, e.code === "KeyY" || e.shiftKey);
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.code) && selected.length) {
      const f = this.projection(); const ctx = this.context(f).ctx;
      this.edits.nudge(selected, e.code as NudgeKey, { shiftBars: ctx.shiftBars, price: f.axes.price }, prefs.lockAll);
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); this.refresh(); }
  }
}
