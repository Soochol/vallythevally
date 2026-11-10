export type Modifier = "ctrl" | "alt" | "shift";
export type CloneModifier = Exclude<Modifier, "shift">;

export interface Mods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export const CLONE_MODIFIER: CloneModifier = "ctrl";

export type PressMode = "select" | "draw" | "erase";
export type PressTarget = "empty" | "body" | "handle";
export type ModeId = "demo" | "eraser";

export type ClickAction = "select" | "toggleSelect" | "clearSelection" | "keepSelection" | "place" | "eraseOne";
export type DragAction = "pan" | "move" | "clone" | "handle" | "box" | "place" | "demo" | "erase" | "erasePartial";
export type HoldEffect = "invertMagnet" | "constrainShape" | "axisLock";

type Target = PressTarget | "any";

export type GestureRow =
  | { kind: "click"; mode: PressMode; target: Target; mod: Modifier | null; action: ClickAction; label: string }
  | { kind: "drag"; mode: PressMode; target: Target; mod: Modifier | null; action: DragAction; label: string }
  | { kind: "hold"; mod: Modifier; during: readonly DragAction[]; effect: HoldEffect; label: string };

export function gesturesFor(clone: CloneModifier): readonly GestureRow[] {
  return [
    { kind: "drag", mode: "select", target: "body", mod: clone, action: "clone", label: "복제" },
    { kind: "drag", mode: "select", target: "body", mod: "alt", action: "pan", label: "차트 옮기기" },
    { kind: "drag", mode: "select", target: "body", mod: null, action: "move", label: "옮기기" },
    { kind: "drag", mode: "select", target: "handle", mod: "alt", action: "pan", label: "차트 옮기기" },
    { kind: "drag", mode: "select", target: "handle", mod: null, action: "handle", label: "점 옮기기" },
    { kind: "drag", mode: "select", target: "empty", mod: "ctrl", action: "box", label: "상자로 고르기" },
    { kind: "drag", mode: "select", target: "empty", mod: "alt", action: "demo", label: "시연 커서" },
    { kind: "drag", mode: "select", target: "empty", mod: null, action: "pan", label: "차트 옮기기" },
    { kind: "drag", mode: "draw", target: "any", mod: null, action: "place", label: "그리기" },
    { kind: "drag", mode: "erase", target: "any", mod: "ctrl", action: "erasePartial", label: "붓 획 일부 지우기" },
    { kind: "drag", mode: "erase", target: "any", mod: null, action: "erase", label: "지나간 드로잉 지우기" },

    { kind: "click", mode: "select", target: "body", mod: "ctrl", action: "toggleSelect", label: "선택에 넣고 빼기" },
    { kind: "click", mode: "select", target: "handle", mod: "ctrl", action: "toggleSelect", label: "선택에 넣고 빼기" },
    { kind: "click", mode: "select", target: "body", mod: null, action: "select", label: "고르기" },
    { kind: "click", mode: "select", target: "handle", mod: null, action: "select", label: "고르기" },
    { kind: "click", mode: "select", target: "empty", mod: "ctrl", action: "keepSelection", label: "선택 유지" },
    { kind: "click", mode: "select", target: "empty", mod: null, action: "clearSelection", label: "선택 풀기" },
    { kind: "click", mode: "draw", target: "any", mod: null, action: "place", label: "점 찍기" },
    { kind: "click", mode: "erase", target: "any", mod: null, action: "eraseOne", label: "지우기" },

    { kind: "hold", mod: "shift", during: ["place", "handle"], effect: "constrainShape", label: "45°·정사각형·원" },
    { kind: "hold", mod: "shift", during: ["move", "clone"], effect: "axisLock", label: "수평·수직으로만 옮기기" },
    { kind: "hold", mod: "ctrl", during: ["place", "handle"], effect: "invertMagnet", label: "자석 잠시 반대로" },
  ];
}

export const GESTURES = gesturesFor(CLONE_MODIFIER);

const MODE_OF: Partial<Record<DragAction, ModeId>> = { demo: "demo", erase: "eraser", erasePartial: "eraser" };

const isAvailable = (row: GestureRow, registered: ReadonlySet<ModeId>) => {
  const needs = row.kind === "drag" ? MODE_OF[row.action] : undefined;
  return needs === undefined || registered.has(needs);
};

export interface PressResolution {
  click: ClickAction;
  drag: DragAction;
  capturesPointer: boolean;
}

const matches = (row: { mode: PressMode; target: Target; mod: Modifier | null }, mode: PressMode, target: PressTarget, mods: Mods) =>
  row.mode === mode && (row.target === "any" || row.target === target) && (row.mod === null || mods[row.mod]);

export function resolvePress(
  mode: PressMode,
  target: PressTarget,
  mods: Mods,
  registered: ReadonlySet<ModeId>,
  rows: readonly GestureRow[] = GESTURES,
): PressResolution | null {
  let click: ClickAction | null = null;
  let drag: DragAction | null = null;
  for (const row of rows) {
    if (row.kind === "hold" || !matches(row, mode, target, mods)) continue;
    if (row.kind === "click") click ??= row.action;
    else if (isAvailable(row, registered)) drag ??= row.action;
  }
  return click === null || drag === null ? null : { click, drag, capturesPointer: drag !== "pan" };
}

export function holds(drag: DragAction, mods: Mods, rows: readonly GestureRow[] = GESTURES): ReadonlySet<HoldEffect> {
  const effects = new Set<HoldEffect>();
  for (const row of rows) if (row.kind === "hold" && mods[row.mod] && row.during.includes(drag)) effects.add(row.effect);
  return effects;
}

const MOD_KEY: Record<Modifier, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
const TARGET_TEXT: Record<Target, string> = { empty: "빈 곳 ", body: "드로잉 ", handle: "핸들 ", any: "" };
const MODE_TEXT: Record<PressMode, string> = { select: "", draw: "그리는 중 ", erase: "지우개로 " };

function keysOf(row: GestureRow): string {
  if (row.kind === "hold") return `${MOD_KEY[row.mod]} 누르고 있기`;
  const prefix = row.mod === null ? "" : `${MOD_KEY[row.mod]}+`;
  return `${prefix}${MODE_TEXT[row.mode]}${TARGET_TEXT[row.target]}${row.kind === "click" ? "클릭" : "끌기"}`;
}

export function gestureHelp(registered: ReadonlySet<ModeId>, rows: readonly GestureRow[] = GESTURES): readonly { keys: string; label: string }[] {
  return rows.filter((row) => isAvailable(row, registered)).map((row) => ({ keys: keysOf(row), label: row.label }));
}
