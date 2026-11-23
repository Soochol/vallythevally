import { describe, expect, it } from "vitest";
import { findUi2Violations, findUndefinedTokens, type SourceFile } from "./styleRules";

const TOKENS_PATH = "/src/styles/tokens.css";
const TOKENS_TEXT = ":root { --text: #fff; --fs-s: 12px; }";
const MARKED = "/src/features/x";

const ui2 = (text: string, name = "a.css") => findUi2Violations([{ path: `${MARKED}/${name}`, text }], [MARKED], TOKENS_PATH);

const BYPASSES: readonly { text: string; rule: string; name?: string }[] = [
  { text: ".a { font: 650 13px/1.4 serif; }", rule: "글자 굵기" },
  { text: ".a { font-size: 0.6rem; }", rule: "글자 크기" },
  { text: ".a { font-size: 0.8em; }", rule: "글자 크기" },
  { text: ".a { font-size: calc(10px + 1px); }", rule: "글자 크기" },
  { text: ".a { font-size: clamp(9px, 1vw, 12px); }", rule: "글자 크기" },
  { text: ".a { font-size: var(--fs-s, 9px); }", rule: "글자 크기" },
  { text: ".a { font-weight: var(--fw, 800); }", rule: "글자 굵기" },
  { text: ".a { color: oklch(70% 0.1 200); }", rule: "색 직접 값" },
  { text: ".a { background: red; }", rule: "색 직접 값" },
  { text: ".a { border-color: rebeccapurple; }", rule: "색 직접 값" },
  { text: `const s = { fontSize: "0.6rem" };`, rule: "글자 크기", name: "A.tsx" },
  { text: `const u = "https://example.invalid/a"; const s = { color: "#fff" };`, rule: "색 직접 값", name: "A.tsx" },
];

const ALLOWED: readonly { text: string; name?: string }[] = [
  { text: ".a { font-weight: 600 !important; } .b { font-size: 12px !important; }" },
  { text: "const s = { fontWeight: weight, fontSize: size };", name: "A.tsx" },
  { text: ".a { font: var(--fs-s)/16px var(--font-sans); }" },
  { text: ".a { font: 600 13px/18px var(--font-sans); }" },
  { text: "const a = 1; // color: #fff; font-size: 9px; font-weight: 800\n", name: "a.ts" },
  { text: ".a { color: transparent; background: currentColor; fill: none; border-color: inherit; }" },
  { text: ".a { font-size: var(--fs-s); font-weight: var(--fw-strong); color: var(--text); }" },
];

describe("표식 폴더 규칙 구멍", () => {
  it("표식 폴더 규칙은 우회 값을 잡는다", () => {
    for (const { text, rule, name } of BYPASSES) {
      expect({ text, caught: ui2(text, name).some((violation) => violation.rule === rule) }).toEqual({ text, caught: true });
    }
  });

  it("표식 폴더 규칙은 허용 값을 잘못 잡지 않는다", () => {
    for (const { text, name } of ALLOWED) {
      expect({ text, violations: ui2(text, name) }).toEqual({ text, violations: [] });
    }
  });
});

describe("정의되지 않은 토큰 범위", () => {
  it("정의되지 않은 토큰 규칙은 다른 폴더의 정의를 치지 않고 TSX 템플릿 선언을 읽는다", () => {
    const crossFolder: SourceFile[] = [
      { path: "/src/features/a/A.tsx", text: `const s = { ["--heat" as string]: "1%" };` },
      { path: "/src/features/b/b.css", text: ".b { width: var(--heat); }" },
    ];
    expect(findUndefinedTokens(crossFolder, TOKENS_PATH, TOKENS_TEXT)).toEqual([{ path: "/src/features/b/b.css", rule: "정의되지 않은 토큰", detail: "--heat" }]);
    const template: SourceFile[] = [
      { path: "/src/features/a/A.tsx", text: "node.style.cssText = `--gap: ${gap}px; width: 1px`;" },
      { path: "/src/features/a/a.css", text: ".a { gap: var(--gap); }" },
    ];
    expect(findUndefinedTokens(template, TOKENS_PATH, TOKENS_TEXT)).toEqual([]);
  });
});
