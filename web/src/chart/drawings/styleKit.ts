import type { Lens, StyleField } from "./toolSpec";
import type { Color, Dash, Extend, Fill, LineEnd, Stroke, TextStyle, Width } from "./types";

export const DRAW: Color = "$draw";
export const UP: Color = "$up";
export const DOWN: Color = "$down";

export const defaultStroke = (): Stroke => ({ color: DRAW, width: 2, dash: "solid" });
export const defaultFill = (): Fill => ({ on: true, color: DRAW, opacity: 0.2 });
export const TEXT_SIZE = { min: 8, max: 72 } as const;
export const defaultText = (): TextStyle => ({ color: DRAW, size: 14, bold: false, italic: false });

export function prop<S, K extends keyof S>(key: K): Lens<S, S[K]> {
  return { get: (s) => s[key], set: (s, v) => ({ ...s, [key]: v }) };
}

export function compose<S, A, V>(outer: Lens<S, A>, inner: Lens<A, V>): Lens<S, V> {
  return { get: (s) => inner.get(outer.get(s)), set: (s, v) => outer.set(s, inner.set(outer.get(s), v)) };
}

export function at<S>() {
  function path<K1 extends keyof S>(k1: K1): Lens<S, S[K1]>;
  function path<K1 extends keyof S, K2 extends keyof S[K1]>(k1: K1, k2: K2): Lens<S, S[K1][K2]>;
  function path<K1 extends keyof S, K2 extends keyof S[K1]>(k1: K1, k2?: K2): Lens<S, S[K1]> | Lens<S, S[K1][K2]> {
    const outer = prop<S, K1>(k1);
    return k2 === undefined ? outer : compose(outer, prop<S[K1], K2>(k2));
  }
  return path;
}

export type StyleRecord = Record<string, unknown>;

export function readRecord(raw: unknown): StyleRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw));
}

export const readBool = (raw: unknown, fallback: boolean): boolean => (typeof raw === "boolean" ? raw : fallback);

export const readNumber = (raw: unknown, fallback: number): number =>
  typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;

export const readString = (raw: unknown, fallback: string): string => (typeof raw === "string" ? raw : fallback);

export function readOneOf<V extends string | number>(raw: unknown, options: readonly V[], fallback: V): V {
  return options.find((o) => o === raw) ?? fallback;
}

const WIDTHS: readonly Width[] = [1, 2, 3, 4, 5];
const DASHES: readonly Dash[] = ["solid", "dashed", "dotted"];
export const EXTENDS: readonly Extend[] = ["none", "left", "right", "both"];
export const LINE_ENDS: readonly LineEnd[] = ["plain", "arrow"];

export function readStroke(raw: unknown, d: Stroke): Stroke {
  const o = readRecord(raw);
  return {
    ...o,
    color: readString(o.color, d.color),
    width: readOneOf(o.width, WIDTHS, d.width),
    dash: readOneOf(o.dash, DASHES, d.dash),
  };
}

export function readFill(raw: unknown, d: Fill): Fill {
  const o = readRecord(raw);
  return {
    ...o,
    on: readBool(o.on, d.on),
    color: readString(o.color, d.color),
    opacity: Math.min(1, Math.max(0, readNumber(o.opacity, d.opacity))),
  };
}

export function readTextStyle(raw: unknown, d: TextStyle): TextStyle {
  const o = readRecord(raw);
  return {
    ...o,
    color: readString(o.color, d.color),
    size: Math.min(TEXT_SIZE.max, Math.max(TEXT_SIZE.min, readNumber(o.size, d.size))),
    bold: readBool(o.bold, d.bold),
    italic: readBool(o.italic, d.italic),
  };
}

export function select<S, V extends string>(
  label: string,
  options: readonly { value: V; label: string }[],
  lens: Lens<S, V>,
): StyleField<S> {
  return {
    kind: "select",
    label,
    options,
    lens: {
      get: (s) => lens.get(s),
      set: (s, v) => {
        const chosen = options.find((o) => o.value === v);
        return chosen === undefined ? s : lens.set(s, chosen.value);
      },
    },
  };
}

export function strokeFields<S>(label: string, stroke: Lens<S, Stroke>): StyleField<S>[] {
  return [
    { kind: "color", label: `${label} 색`, lens: compose(stroke, prop<Stroke, "color">("color")) },
    { kind: "width", label: `${label} 굵기`, lens: compose(stroke, prop<Stroke, "width">("width")) },
    { kind: "dash", label: `${label} 모양`, lens: compose(stroke, prop<Stroke, "dash">("dash")) },
  ];
}

export const EXTEND_OPTIONS: readonly { value: Extend; label: string }[] = [
  { value: "none", label: "없음" },
  { value: "left", label: "왼쪽" },
  { value: "right", label: "오른쪽" },
  { value: "both", label: "양쪽" },
];
