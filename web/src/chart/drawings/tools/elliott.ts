import { readOneOf, select, type StyleRecord } from "../styleKit";
import type { Lens, Tool } from "../toolSpec";
import { definePatternTool, patternDefaults, type PatternStyle, readPatternStyle } from "./patternKit";

export type WaveStyle<F extends string> = PatternStyle & { form: F };

interface WaveForm<F extends string> {
  value: F;
  label: string;
  marks: readonly string[];
}

interface WaveToolSpec<F extends string> {
  tool: "elliott" | "elliottabc";
  label: string;
  icon: string;
  count: 4 | 6;
  forms: readonly [WaveForm<F>, ...WaveForm<F>[]];
}

function defineWaveTool<F extends string>(spec: WaveToolSpec<F>): Tool {
  const values = spec.forms.map((f) => f.value);
  const first = spec.forms[0].value;
  const defaults = (): WaveStyle<F> => ({ ...patternDefaults(), form: first });
  const form: Lens<WaveStyle<F>, F> = { get: (s) => s.form, set: (s, v) => ({ ...s, form: v }) };
  const marksOf = (style: WaveStyle<F>) => spec.forms.find((f) => f.value === style.form)?.marks ?? [];
  return definePatternTool<WaveStyle<F>>({
    tool: spec.tool,
    label: spec.label,
    icon: spec.icon,
    count: spec.count,
    roles: spec.forms[0].marks.map((mark) => `점 ${mark}`),
    defaultStyle: defaults,
    parseStyle: (o: StyleRecord) => ({ ...readPatternStyle(o), form: readOneOf(o.form, values, first) }),
    textFields: [select("꼬리표 모양", spec.forms.map(({ value, label }) => ({ value, label })), form)],
    labels: marksOf,
  });
}

export type ImpulseForm = "number" | "paren" | "roman";

export const elliott = defineWaveTool<ImpulseForm>({
  tool: "elliott",
  label: "엘리엇 충격 파동",
  icon: "M2 19 L6 11 L9 15 L15 4 L18 10 L22 6",
  count: 6,
  forms: [
    { value: "number", label: "숫자 1", marks: ["0", "1", "2", "3", "4", "5"] },
    { value: "paren", label: "괄호 (1)", marks: ["(0)", "(1)", "(2)", "(3)", "(4)", "(5)"] },
    { value: "roman", label: "로마 숫자 i", marks: ["0", "i", "ii", "iii", "iv", "v"] },
  ],
});

export type CorrectiveForm = "upper" | "paren" | "lower";

export const elliottabc = defineWaveTool<CorrectiveForm>({
  tool: "elliottabc",
  label: "엘리엇 조정 파동",
  icon: "M3 5 L9 16 L14 10 L21 20",
  count: 4,
  forms: [
    { value: "upper", label: "대문자 A", marks: ["0", "A", "B", "C"] },
    { value: "paren", label: "괄호 (A)", marks: ["(0)", "(A)", "(B)", "(C)"] },
    { value: "lower", label: "소문자 a", marks: ["0", "a", "b", "c"] },
  ],
});
