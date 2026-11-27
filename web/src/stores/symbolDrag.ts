import { create } from "zustand";
import type { SymbolCode } from "../api/generated/SymbolCode";
import { WINDOW_KINDS, type WindowId, type WindowKind } from "../layout/kinds";
import { useLayoutStore } from "./layout";
import { useSelectionStore } from "./selection";
import { addSymbolToTapeMatrix } from "../features/tape-matrix/TapeMatrixWindow";

export const SYMBOL_DRAG_MIME = "application/x-vally-symbol";

export interface SymbolDragPayload {
  readonly code: SymbolCode;
  readonly name: string;
  readonly sourceWindow: WindowId | null;
}

export interface SymbolDropTarget {
  readonly windowId: WindowId;
  readonly kind: WindowKind;
  readonly surface: "panel" | "tab";
}

interface SymbolDragState {
  payload: SymbolDragPayload | null;
  outsideSource: boolean;
  point: { readonly x: number; readonly y: number } | null;
  target: SymbolDropTarget | null;
  start(payload: SymbolDragPayload): void;
  move(point: { readonly x: number; readonly y: number }, outsideSource: boolean): void;
  setTarget(target: SymbolDropTarget | null): void;
  end(): void;
}

export const isSymbolDropKind = (kind: WindowKind): boolean =>
  WINDOW_KINDS[kind].link === "follows" || kind === "tape_matrix";

export const useSymbolDragStore = create<SymbolDragState>((set) => ({
  payload: null,
  outsideSource: false,
  point: null,
  target: null,
  start: (payload) => set({ payload, outsideSource: false, point: null, target: null }),
  move: (point, outsideSource) =>
    set((s) => (s.payload === null ? s : { point, outsideSource, target: outsideSource ? s.target : null })),
  setTarget: (target) =>
    set((s) => {
      if (s.target === target) return s;
      if (s.target && target && s.target.windowId === target.windowId && s.target.surface === target.surface) return s;
      return { target };
    }),
  end: () => set({ payload: null, outsideSource: false, point: null, target: null }),
}));

export function readDraggedSymbol(dataTransfer: DataTransfer | null): SymbolDragPayload | null {
  const active = useSymbolDragStore.getState().payload;
  if (active !== null) return active;
  if (!dataTransfer) return null;
  const raw = dataTransfer.getData(SYMBOL_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SymbolDragPayload>;
    if (typeof parsed.code !== "string" || typeof parsed.name !== "string") return null;
    return { code: parsed.code as SymbolCode, name: parsed.name, sourceWindow: parsed.sourceWindow ?? null };
  } catch {
    return null;
  }
}

export function hasDraggedSymbol(dataTransfer: DataTransfer | null): boolean {
  if (useSymbolDragStore.getState().payload !== null) return true;
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types).includes(SYMBOL_DRAG_MIME);
}

let cachedBlankImage: HTMLCanvasElement | null = null;

export function emptyDragImage(): HTMLCanvasElement {
  if (!cachedBlankImage) {
    cachedBlankImage = document.createElement("canvas");
    cachedBlankImage.width = 1;
    cachedBlankImage.height = 1;
  }
  return cachedBlankImage;
}

export function symbolDropBadgeText(kind: WindowKind, payload: SymbolDragPayload): string {
  if (kind === "tape_matrix") return `미니 그리드에 ${payload.name}(${payload.code}) 추가`;
  return `${payload.name}(${payload.code})로 전환`;
}

export function applySymbolDrop(
  windowId: WindowId,
  kind: WindowKind,
  payload: SymbolDragPayload,
  surface: "panel" | "tab",
): void {
  if (kind === "tape_matrix") {
    const result = addSymbolToTapeMatrix(windowId, payload.code);
    if (result === "duplicate") {
      useSelectionStore.getState().showToast(`${payload.name}(${payload.code})는 이미 호가 미니 그리드에 있습니다`);
    }
    if (surface === "tab") useLayoutStore.getState().selectTab(windowId);
    useSymbolDragStore.getState().end();
    return;
  }
  const { notice } = useLayoutStore.getState().dropSymbolOnWindow(windowId, { code: payload.code, name: payload.name });
  if (notice) useSelectionStore.getState().showToast(notice);
  if (surface === "tab") useLayoutStore.getState().selectTab(windowId);
  useSymbolDragStore.getState().end();
}
