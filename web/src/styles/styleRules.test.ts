import { describe, expect, it } from "vitest";
import { findUi2Violations, findUndefinedTokens, folderOf, type SourceFile } from "./styleRules";

const TOKENS_PATH = "/src/styles/tokens.css";
const TOKENS_TEXT = ":root { --text: #fff; --size-3: 3px; }";

const rawSources = import.meta.glob<string>(["/src/**/*.{css,ts,tsx}", "!/src/**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true });
const markerPaths = Object.keys(import.meta.glob<string>("/src/**/.ui2", { query: "?raw", import: "default", eager: true }));
const sources: SourceFile[] = Object.entries(rawSources).map(([path, text]) => ({ path, text }));
const markedFolders = markerPaths.map(folderOf);

const ui2 = (text: string, name = "a.css"): ReturnType<typeof findUi2Violations> =>
  findUi2Violations([{ path: `/src/features/x/${name}`, text }], ["/src/features/x"], TOKENS_PATH);

describe("정의되지 않은 토큰 규칙", () => {
  it("정의되지 않은 토큰을 쓰면 실패한다", () => {
    const violations = findUndefinedTokens([{ path: "/src/features/a/a.css", text: ".a { gap: var(--size-99); color: var(--text); }" }], TOKENS_PATH, TOKENS_TEXT);
    expect(violations).toEqual([{ path: "/src/features/a/a.css", rule: "정의되지 않은 토큰", detail: "--size-99" }]);
  });

  it("같은 CSS 파일이 정의한 지역 변수는 통과한다", () => {
    const text = ".a { --local: 4px; } .b { width: var(--local); }";
    expect(findUndefinedTokens([{ path: "/src/features/a/a.css", text }], TOKENS_PATH, TOKENS_TEXT)).toEqual([]);
  });

  it("TSX가 style 객체나 setProperty로 정한 변수는 CSS에서 써도 통과한다", () => {
    const files: SourceFile[] = [
      { path: "/src/features/a/a.css", text: ".a { width: var(--heat); height: var(--row-px); }" },
      { path: "/src/features/a/A.tsx", text: `const s = { ["--heat" as string]: "1%" }; node.style.setProperty("--row-px", "3px");` },
    ];
    expect(findUndefinedTokens(files, TOKENS_PATH, TOKENS_TEXT)).toEqual([]);
  });

  it("TSX가 변수 이름을 읽기만 하면 정의로 치지 않는다", () => {
    const files: SourceFile[] = [
      { path: "/src/features/a/a.css", text: ".a { color: var(--gone); }" },
      { path: "/src/chart/theme.ts", text: `const gone = v("--gone");` },
    ];
    expect(findUndefinedTokens(files, TOKENS_PATH, TOKENS_TEXT).map((violation) => violation.detail)).toEqual(["--gone"]);
  });

  it("보간으로 이어 붙이는 이름은 정의 여부를 알 수 없어 건너뛴다", () => {
    const text = "const c = `color-mix(in srgb, var(--tile-${side}) 40%, var(--text))`;";
    expect(findUndefinedTokens([{ path: "/src/features/a/colors.ts", text }], TOKENS_PATH, TOKENS_TEXT)).toEqual([]);
  });

  it("@theme의 자기 참조 선언은 정의로 치지 않아 tokens.css에서 지우면 실패한다", () => {
    const files: SourceFile[] = [
      { path: "/src/styles/index.css", text: "@theme inline { --font-sans: var(--font-sans); }" },
      { path: "/src/styles/ui.css", text: "body { font-family: var(--font-sans); }" },
    ];
    expect(findUndefinedTokens(files, TOKENS_PATH, TOKENS_TEXT).map((violation) => `${violation.path} ${violation.detail}`)).toEqual(["/src/styles/index.css --font-sans", "/src/styles/ui.css --font-sans"]);
    expect(findUndefinedTokens(files, TOKENS_PATH, `${TOKENS_TEXT} :root { --font-sans: serif; }`)).toEqual([]);
  });

  it("tokens.css 안의 var()도 정의돼 있어야 한다", () => {
    const violations = findUndefinedTokens([], TOKENS_PATH, ":root { --mono: var(--font-sanz); --a: 1px; --b: var(--a); }");
    expect(violations).toEqual([{ path: TOKENS_PATH, rule: "정의되지 않은 토큰", detail: "--font-sanz" }]);
  });

  it("주석 안의 var()는 세지 않는다", () => {
    const text = "/* var(--nope) */ .a { color: var(--text); }";
    expect(findUndefinedTokens([{ path: "/src/features/a/a.css", text }], TOKENS_PATH, TOKENS_TEXT)).toEqual([]);
  });

  it("앱 진입 파일이 import하는 CSS에서 @import로 닿는 시트만 다른 폴더의 정의를 쓴다", () => {
    const definer: SourceFile = { path: "/src/features/q/Q.tsx", text: `node.style.setProperty("--far", "1px");` };
    const reached: SourceFile[] = [
      { path: "/src/main.tsx", text: `import "./styles/index.css";` },
      { path: "/src/styles/index.css", text: `@import "./part.css";` },
      { path: "/src/styles/part.css", text: ".p { width: var(--far); }" },
      definer,
    ];
    expect(findUndefinedTokens(reached, TOKENS_PATH, TOKENS_TEXT)).toEqual([]);
    const featureOnly: SourceFile[] = [
      { path: "/src/main.tsx", text: `import "./styles/index.css";` },
      { path: "/src/styles/index.css", text: ".i { color: var(--text); }" },
      { path: "/src/features/b/b.css", text: `@import "./c.css"; .b { width: var(--far); }` },
      { path: "/src/features/b/c.css", text: ".c { height: var(--far); }" },
      definer,
    ];
    expect(findUndefinedTokens(featureOnly, TOKENS_PATH, TOKENS_TEXT).map((violation) => `${violation.path} ${violation.detail}`)).toEqual([
      "/src/features/b/b.css --far",
      "/src/features/b/c.css --far",
    ]);
  });

  it("지금 저장소에서 정의되지 않은 토큰 사용이 0건이다", () => {
    const tokensText = rawSources[TOKENS_PATH];
    expect(tokensText).toBeDefined();
    expect(findUndefinedTokens(sources, TOKENS_PATH, tokensText!)).toEqual([]);
  });

  it("CSS가 쓰는 --size-3·--size-6·--size-180이 tokens.css에 정의돼 있고 쓰지 않는 --mono는 없다", () => {
    const tokensText = rawSources[TOKENS_PATH]!;
    for (const name of ["--size-3", "--size-6", "--size-180"]) expect(tokensText).toMatch(new RegExp(`${name}\\s*:`));
    expect(tokensText).not.toMatch(/--mono\s*:/);
  });
});

describe("표식(.ui2)이 있는 폴더 규칙", () => {
  it("표식이 있는 폴더의 허용 밖 굵기를 잡는다", () => {
    expect(ui2(".a { font-weight: 650; } .b { font-weight: 800; }").map((violation) => violation.detail)).toEqual(["650", "800"]);
    expect(ui2(".a { font-weight: 400; } .b { font-weight: 500; } .c { font-weight: 600; } .d { font-weight: 700; } .e { font-weight: bold; }")).toEqual([]);
    expect(ui2("const s = { fontWeight: 300 };", "A.tsx").map((violation) => violation.rule)).toEqual(["글자 굵기"]);
  });

  it("표식이 있는 폴더의 허용 밖 px 글자 크기와 --size-* 우회를 잡는다", () => {
    expect(ui2(".a { font-size: 10px; } .b { font-size: 15px; } .c { font-size: var(--size-10); }").map((violation) => violation.detail)).toEqual(["10px", "15px", "--size-10"]);
    expect(ui2(".a { font-size: 11px; } .b { font-size: 28px; } .c { font-size: var(--fs-s); } .d { font: 600 13px/1.4 serif; }")).toEqual([]);
    expect(ui2("const s = { fontSize: 21 };", "A.tsx").map((violation) => violation.rule)).toEqual(["글자 크기"]);
  });

  it("표식이 있는 폴더의 색 직접 값을 잡는다", () => {
    const found = ui2(".a { color: #fff; background: rgba(0, 0, 0, 0.5); border-color: rgb(1, 2, 3); }");
    expect(found.map((violation) => violation.detail)).toEqual(["#fff", "rgba(", "rgb("]);
    expect(ui2(".a { color: var(--text); background: color-mix(in srgb, var(--accent) 20%, transparent); }")).toEqual([]);
  });

  it("선택자에 콜론이 있는 블록과 @media 안의 선언도 잡는다", () => {
    const cases: readonly { text: string; rule: string }[] = [
      { text: ".a:hover { font-weight: 800 }", rule: "글자 굵기" },
      { text: ".a::before { font-size: 9px }", rule: "글자 크기" },
      { text: "@media (max-width: 600px) { .a { font-size: 9px } }", rule: "글자 크기" },
      { text: ".a:hover { color: red }", rule: "색 직접 값" },
      { text: ".a:hover{font-size:9px}", rule: "글자 크기" },
      { text: ".a:hover{color:red}", rule: "색 직접 값" },
    ];
    for (const { text, rule } of cases) {
      expect({ text, caught: ui2(text).some((violation) => violation.rule === rule) }).toEqual({ text, caught: true });
    }
    expect(ui2("@media (max-width: 600px) { .a:hover { font-size: var(--fs-s); color: var(--text); } }")).toEqual([]);
  });

  it("표식이 없는 폴더와 tokens.css는 검사하지 않는다", () => {
    const loud = ".a { font-weight: 900; color: #fff; font-size: 9px; }";
    expect(findUi2Violations([{ path: "/src/features/y/a.css", text: loud }], ["/src/features/x"], TOKENS_PATH)).toEqual([]);
    expect(findUi2Violations([{ path: TOKENS_PATH, text: loud }], ["/src"], TOKENS_PATH)).toEqual([]);
  });

  it("표식은 하위 폴더에도 적용되고 이웃 폴더 이름이 앞부분만 같으면 적용되지 않는다", () => {
    const loud = ".a { color: #fff; }";
    const files: SourceFile[] = [
      { path: "/src/features/x/deep/a.css", text: loud },
      { path: "/src/features/xy/a.css", text: loud },
    ];
    expect(findUi2Violations(files, ["/src/features/x"], TOKENS_PATH).map((violation) => violation.path)).toEqual(["/src/features/x/deep/a.css"]);
  });

  it("지금 표식이 있는 폴더는 규칙을 지킨다", () => {
    expect(findUi2Violations(sources, markedFolders, TOKENS_PATH)).toEqual([]);
  });
});
