export interface SourceFile { path: string; text: string }

export interface RuleViolation { path: string; rule: string; detail: string }

export const ALLOWED_FONT_WEIGHTS: readonly number[] = [400, 500, 600, 700];
export const ALLOWED_FONT_SIZES_PX: readonly number[] = [11, 12, 13, 14, 17, 20, 28];

const CUSTOM_PROPERTY_USE = /var\(\s*(--[\w-]+)(?![\w-]|\$\{)/g;
const CSS_DECLARATION = /(--[\w-]+)\s*:/g;
const SCRIPT_DECLARATION = /["'`](--[\w-]+)["'`](?:\s+as\s+\w+\s*\])?\s*:|setProperty\(\s*["'`](--[\w-]+)["'`]/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

const isStyleSheet = (path: string): boolean => path.endsWith(".css");

function localDeclarations(file: SourceFile): Set<string> {
  const names = new Set<string>();
  const pattern = isStyleSheet(file.path) ? CSS_DECLARATION : SCRIPT_DECLARATION;
  for (const match of file.text.replace(BLOCK_COMMENT, "").matchAll(pattern)) names.add((match[1] ?? match[2])!);
  return names;
}

export function findUndefinedTokens(files: readonly SourceFile[], tokensPath: string, tokensText: string): RuleViolation[] {
  const tokens = localDeclarations({ path: tokensPath, text: tokensText });
  const locals = new Set<string>();
  for (const file of files) if (file.path !== tokensPath) for (const name of localDeclarations(file)) locals.add(name);
  const violations: RuleViolation[] = [];
  for (const file of files) {
    if (file.path === tokensPath) continue;
    const reported = new Set<string>();
    for (const match of file.text.replace(BLOCK_COMMENT, "").matchAll(CUSTOM_PROPERTY_USE)) {
      const name = match[1]!;
      if (tokens.has(name) || locals.has(name) || reported.has(name)) continue;
      reported.add(name);
      violations.push({ path: file.path, rule: "정의되지 않은 토큰", detail: name });
    }
  }
  return violations;
}

export const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

const isInside = (path: string, folder: string): boolean => path.startsWith(`${folder}/`);

const FONT_WEIGHT_USES = [/font-weight\s*:\s*([^;}\n]+)/g, /fontWeight\s*:\s*["']?([\w.]+)/g, /\bfont-\[(\d+)\]/g];
const FONT_SIZE_USES = [/font-size\s*:\s*([\d.]+)px/g, /fontSize\s*:\s*["']?([\d.]+)(?:px)?["']?\s*[,}]/g, /\btext-\[([\d.]+)px\]/g];
const FONT_SHORTHAND_PX = /font\s*:\s*[^;}]*?\b([\d.]+)px/g;
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi;

const FONT_WEIGHT_KEYWORDS: Record<string, number> = { normal: 400, bold: 700 };

function checkFile(file: SourceFile): RuleViolation[] {
  const text = file.text.replace(BLOCK_COMMENT, "");
  const violations: RuleViolation[] = [];
  const report = (rule: string, detail: string) => violations.push({ path: file.path, rule, detail });
  for (const pattern of FONT_WEIGHT_USES) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1]!.trim();
      if (/^var\(/.test(raw) || raw === "inherit") continue;
      const weight = FONT_WEIGHT_KEYWORDS[raw] ?? Number(raw);
      if (!ALLOWED_FONT_WEIGHTS.includes(weight)) report("글자 굵기", raw);
    }
  }
  for (const pattern of [...FONT_SIZE_USES, FONT_SHORTHAND_PX]) {
    for (const match of text.matchAll(pattern)) {
      const size = Number(match[1]);
      if (!ALLOWED_FONT_SIZES_PX.includes(size)) report("글자 크기", `${match[1]}px`);
    }
  }
  for (const match of text.matchAll(COLOR_LITERAL)) report("색 직접 값", match[0]);
  return violations;
}

export function findUi2Violations(files: readonly SourceFile[], markedFolders: readonly string[], tokensPath: string): RuleViolation[] {
  return files
    .filter((file) => file.path !== tokensPath && markedFolders.some((folder) => isInside(file.path, folder)))
    .flatMap(checkFile);
}
