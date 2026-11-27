export interface SourceFile { path: string; text: string }

export interface RuleViolation { path: string; rule: string; detail: string }

export const ALLOWED_FONT_WEIGHTS: readonly number[] = [400, 500, 600, 700];
export const ALLOWED_FONT_SIZES_PX: readonly number[] = [11, 12, 13, 14, 17, 20, 28];

const CUSTOM_PROPERTY_USE = /var\(\s*(--[\w-]+)(?![\w-]|\$\{)/g;
const CSS_DECLARATION = /(?<![\w-])(--[\w-]+)\s*:(?!\s*var\(\s*\1\s*\))/g;
const SCRIPT_DECLARATION = /["'`](--[\w-]+)["'`](?:\s+as\s+\w+\s*\])?\s*:|setProperty\(\s*["'`](--[\w-]+)["'`]/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const IMPORT_SPECIFIER = /(?:\bimport\s*(?:[^"'`;]*?\bfrom\s*)?|\bimport\s*\(\s*|@import\s+(?:url\(\s*)?)["']([^"']+)["']/g;
const APP_ENTRY = /\/main\.tsx?$/;
const RESOLVED_SUFFIXES = ["", ".ts", ".tsx", ".css", "/index.ts", "/index.tsx", "/index.css"];

const isStyleSheet = (path: string): boolean => path.endsWith(".css");

export const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

const isInside = (path: string, folder: string): boolean => path.startsWith(`${folder}/`);

interface ScannedScript { code: string; literals: string[] }

function scanScript(text: string): ScannedScript {
  let code = "";
  const literals: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
    } else if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
    } else if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < text.length && text[end] !== char && !(char !== "`" && text[end] === "\n")) end += text[end] === "\\" ? 2 : 1;
      literals.push(text.slice(index + 1, end));
      code += text.slice(index, end + 1);
      index = end + 1;
    } else {
      code += char;
      index += 1;
    }
  }
  return { code, literals };
}

const sourceCode = (file: SourceFile): string => (isStyleSheet(file.path) ? file.text.replace(BLOCK_COMMENT, "") : scanScript(file.text).code);

function localDeclarations(file: SourceFile): Set<string> {
  const names = new Set<string>();
  const code = sourceCode(file);
  const patterns = isStyleSheet(file.path) ? [CSS_DECLARATION] : [SCRIPT_DECLARATION, CSS_DECLARATION];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) names.add((match[1] ?? match[2])!);
  return names;
}

function resolveImports(file: SourceFile, knownPaths: ReadonlySet<string>): string[] {
  const folder = folderOf(file.path);
  const resolved: string[] = [];
  for (const match of sourceCode(file).matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1]!.replace(/[?#].*$/, "");
    if (!specifier.startsWith(".")) continue;
    const segments = `${folder}/${specifier}`.split("/");
    const normalized: string[] = [];
    for (const segment of segments) {
      if (segment === "..") normalized.pop();
      else if (segment !== ".") normalized.push(segment);
    }
    const base = normalized.join("/");
    const target = RESOLVED_SUFFIXES.map((suffix) => `${base}${suffix}`).find((candidate) => knownPaths.has(candidate));
    if (target !== undefined) resolved.push(target);
  }
  return resolved;
}

export function findUndefinedTokens(files: readonly SourceFile[], tokensPath: string, tokensText: string): RuleViolation[] {
  const tokens = localDeclarations({ path: tokensPath, text: tokensText });
  const all: SourceFile[] = [...files.filter((candidate) => candidate.path !== tokensPath), { path: tokensPath, text: tokensText }];
  const knownPaths = new Set(all.map((file) => file.path));
  const declarations = new Map(all.map((file) => [file.path, localDeclarations(file)]));
  const importsOf = new Map(all.map((file) => [file.path, resolveImports(file, knownPaths)]));
  const importers = new Map<string, string[]>();
  for (const [importer, targets] of importsOf) for (const target of targets) importers.set(target, [...(importers.get(target) ?? []), importer]);
  const globalSheets = new Set<string>();
  const pending = all.filter((file) => APP_ENTRY.test(file.path)).flatMap((entry) => importsOf.get(entry.path)!).filter(isStyleSheet);
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (globalSheets.has(path)) continue;
    globalSheets.add(path);
    pending.push(...importsOf.get(path)!.filter(isStyleSheet));
  }
  const namesOf = (paths: Iterable<string>): string[] => [...paths].flatMap((path) => [...declarations.get(path)!]);
  const globalNames = namesOf(globalSheets);
  const everyName = namesOf(declarations.keys());
  const visibleFrom = (file: SourceFile): Set<string> => {
    if (globalSheets.has(file.path)) return new Set(everyName);
    const folder = folderOf(file.path);
    const sameFolder = all.filter((other) => folderOf(other.path) === folder).map((other) => other.path);
    return new Set([...tokens, ...globalNames, ...namesOf(sameFolder), ...namesOf(importers.get(file.path) ?? [])]);
  };
  const violations: RuleViolation[] = [];
  for (const file of all) {
    const visible = visibleFrom(file);
    const reported = new Set<string>();
    for (const match of sourceCode(file).matchAll(CUSTOM_PROPERTY_USE)) {
      const name = match[1]!;
      if (visible.has(name) || reported.has(name)) continue;
      reported.add(name);
      violations.push({ path: file.path, rule: "정의되지 않은 토큰", detail: name });
    }
  }
  return violations;
}

const GLOBAL_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const WEIGHT_KEYWORDS = new Set(["normal", "bold"]);
const IMPORTANT = /\s*!\s*important\s*$/i;
const VARIABLE_CALL = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/i;
const LENGTH_START = /^(?:[\d.]+[a-z%]+|(?:calc|clamp|min|max)\()/i;

const NAMED_COLORS = `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(" ");

const NAMED_COLOR = new RegExp(`(?<![\\w-])(?:${NAMED_COLORS.join("|")})(?![\\w(-])`, "gi");
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(|\bcolor\(\s*(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65|from)\b/gi;
const COLOR_PROPERTY = /^(?:--[\w-]+|color|fill|stroke|[\w-]*-color|background(?:-image)?|border(?:-[a-z]+)*|outline|box-shadow|text-shadow|text-decoration|text-emphasis|column-rule|filter|backdrop-filter)$/;
const SCRIPT_COLOR_KEY = /\b(color|background|backgroundColor|borderColor|border|outline|outlineColor|fill|stroke|stopColor|boxShadow|textShadow|caretColor|accentColor)\s*[:=]\s*(?:\{\s*)?(["'`])([^"'`]*)\2/g;
const SCRIPT_WEIGHT_KEY = /\bfontWeight\s*:\s*(?:(["'`])((?:(?!\1)[^\\])*)\1|(\d+(?:\.\d+)?)(?=\s*(?:[,})\n]|$)))/g;
const SCRIPT_SIZE_KEY = /\bfontSize\s*:\s*(?:(["'`])((?:(?!\1)[^\\])*)\1|(\d+(?:\.\d+)?)(?=\s*(?:[,})\n]|$)))/g;
const TAILWIND_WEIGHT = /\bfont-\[(\d+)\]/g;
const TAILWIND_SIZE = /\btext-\[([\d.]+(?:px|r?em))\]/g;

const withoutImportant = (value: string): string => value.replace(IMPORTANT, "").trim();

function splitTopLevel(value: string, separator: string | RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    const isSeparator = depth === 0 && (typeof separator === "string" ? char === separator : separator.test(char));
    if (isSeparator) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

const whitespaceTokens = (value: string): string[] => splitTopLevel(value, /\s/);

function weightViolations(value: string): string[] {
  return whitespaceTokens(withoutImportant(value)).flatMap((token) => {
    const variable = VARIABLE_CALL.exec(token);
    if (variable) return variable[2] === undefined ? [] : weightViolations(variable[2]);
    const keyword = token.toLowerCase();
    if (GLOBAL_KEYWORDS.has(keyword) || WEIGHT_KEYWORDS.has(keyword)) return [];
    return ALLOWED_FONT_WEIGHTS.includes(Number(token)) ? [] : [token];
  });
}

function sizeViolations(value: string): string[] {
  const text = withoutImportant(value);
  if (text === "") return [];
  const variable = VARIABLE_CALL.exec(text);
  if (variable) {
    if (variable[1]!.startsWith("--size-")) return [variable[1]!];
    return variable[2] === undefined ? [] : sizeViolations(variable[2]);
  }
  if (GLOBAL_KEYWORDS.has(text.toLowerCase())) return [];
  const pixels = /^([\d.]+)(?:px)?$/i.exec(text);
  if (pixels) return ALLOWED_FONT_SIZES_PX.includes(Number(pixels[1])) ? [] : [`${pixels[1]}px`];
  return [text];
}

function fontShorthandViolations(value: string): { rule: string; detail: string }[] {
  const tokens = whitespaceTokens(withoutImportant(value));
  const lengthIndex = tokens.findIndex((token) => LENGTH_START.test(token));
  const sizeIndex = lengthIndex >= 0 ? lengthIndex : tokens.findIndex((token) => token.toLowerCase().startsWith("var("));
  if (sizeIndex < 0) return [];
  const weightTokens = tokens.slice(0, sizeIndex).filter((token) => /^[\d.]+$/.test(token) || /^(?:bolder|lighter)$/i.test(token) || token.toLowerCase().startsWith("var("));
  const size = splitTopLevel(tokens[sizeIndex]!, "/")[0] ?? "";
  return [
    ...weightViolations(weightTokens.join(" ")).map((detail) => ({ rule: "글자 굵기", detail })),
    ...sizeViolations(size).map((detail) => ({ rule: "글자 크기", detail })),
  ];
}

function namedColorsIn(value: string): string[] {
  return [...value.replace(/url\([^)]*\)/gi, "").matchAll(NAMED_COLOR)].map((match) => match[0]);
}

function declarationsOf(text: string, isStyleSheetText: boolean): { property: string; value: string }[] {
  const pattern = isStyleSheetText
    ? /(?:^|[{;])\s*([a-z-][\w-]*)\s*:\s*([^;{}]+)/gi
    : /(?<![\w-])([a-z-][\w-]*)\s*:\s*([^;}\n"'`]+)/gi;
  return [...text.matchAll(pattern)].map((match) => ({ property: match[1]!.toLowerCase(), value: match[2]! }));
}

function scriptValues(code: string, pattern: RegExp): string[] {
  const values: string[] = [];
  for (const match of code.matchAll(pattern)) {
    const text = match[2] ?? match[3];
    if (text !== undefined && !text.includes("${")) values.push(text);
  }
  return values;
}

function checkFile(file: SourceFile): RuleViolation[] {
  const isCss = isStyleSheet(file.path);
  const scanned = isCss ? { code: file.text.replace(BLOCK_COMMENT, ""), literals: [] } : scanScript(file.text);
  const { code } = scanned;
  const violations: RuleViolation[] = [];
  const report = (rule: string, detail: string) => violations.push({ path: file.path, rule, detail });
  const cssTexts = isCss ? [code] : scanned.literals;

  for (const { property, value } of declarationsOf(code, isCss)) {
    if (property === "font-weight") for (const detail of weightViolations(value)) report("글자 굵기", detail);
    else if (property === "font-size") for (const detail of sizeViolations(value)) report("글자 크기", detail);
    else if (property === "font") for (const { rule, detail } of fontShorthandViolations(value)) report(rule, detail);
  }
  for (const value of scriptValues(code, SCRIPT_WEIGHT_KEY)) for (const detail of weightViolations(value)) report("글자 굵기", detail);
  for (const value of scriptValues(code, SCRIPT_SIZE_KEY)) for (const detail of sizeViolations(value)) report("글자 크기", detail);
  for (const match of code.matchAll(TAILWIND_WEIGHT)) for (const detail of weightViolations(match[1]!)) report("글자 굵기", detail);
  for (const match of code.matchAll(TAILWIND_SIZE)) for (const detail of sizeViolations(match[1]!)) report("글자 크기", detail);

  for (const text of cssTexts) {
    for (const match of text.matchAll(COLOR_LITERAL)) report("색 직접 값", match[0]);
    for (const { property, value } of declarationsOf(text, isCss)) {
      if (COLOR_PROPERTY.test(property)) for (const name of namedColorsIn(value)) report("색 직접 값", name);
    }
  }
  if (!isCss) {
    for (const match of code.matchAll(SCRIPT_COLOR_KEY)) for (const name of namedColorsIn(match[3]!)) report("색 직접 값", name);
  }
  return violations;
}

export function findUi2Violations(files: readonly SourceFile[], markedFolders: readonly string[], tokensPath: string): RuleViolation[] {
  return files
    .filter((file) => file.path !== tokensPath && markedFolders.some((folder) => isInside(file.path, folder)))
    .flatMap(checkFile);
}
