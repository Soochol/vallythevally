import { readFile } from "node:fs/promises";
import { beforeAll, expect, test } from "vitest";
import { KIND_ORDER, KINDS } from "../../chart/indicators/kinds";
import init, { validateSpec } from "../../wasm/indicators/indicators.js";
import { checkForm, formFromSpec, placeErrors, type SpecForm, type Validate } from "./indicatorForm";

const validate: Validate = (spec) => validateSpec(JSON.stringify(spec));
const edit = (form: SpecForm, text: Record<string, string>): SpecForm => ({ ...form, text: { ...form.text, ...text } });
const placed = (form: SpecForm) => placeErrors(form.kind, checkForm(form, validate).errors);

beforeAll(async () => {
  await init({ module_or_path: await readFile(new URL("../../wasm/indicators/indicators_bg.wasm", import.meta.url)) });
});

test("기본값은 실제 wasm 검사를 통과한다", () => {
  for (const kind of KIND_ORDER) expect(checkForm(formFromSpec(KINDS[kind].defaults), validate).ok).toBe(true);
});

test("wasm 오류는 그 입력칸 아래로 간다", () => {
  expect(placed(edit(formFromSpec(KINDS.macd.defaults), { fast: "26", slow: "12" }))).toEqual({ byField: { slow: ["fast보다 커야 합니다."] }, rest: [] });
  expect(placed(edit(formFromSpec(KINDS.ma.defaults), { period: "0" }))).toEqual({ byField: { period: ["1 이상이어야 합니다."] }, rest: [] });
  expect(placed(edit(formFromSpec(KINDS.bollinger.defaults), { k: "-1" }))).toEqual({ byField: { k: ["0보다 큰 수여야 합니다."] }, rest: [] });
});

test("65535를 넘는 값은 읽을 수 없는 설정이라 맨 아래에 적는다", () => {
  const { byField, rest } = placed(edit(formFromSpec(KINDS.ma.defaults), { period: "70000" }));
  expect(byField).toEqual({});
  expect(rest).toHaveLength(1);
  expect(rest[0]).toMatch(/^지표 설정을 읽을 수 없습니다/);
});
