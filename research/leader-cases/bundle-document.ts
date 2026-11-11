import type { Bundle } from "./bundle-types.ts";
import { fields, integer, list, text } from "./source-utils.ts";

const BUNDLE_LAYOUT = {
  schemaVersion: "value", generatedAt: "value", code: "value", range: "value", calendar: "array", sectorMap: "value", symbol: "value", currentFundamentals: "value",
  prices: "array", sectors: "array", technical: "array", markets: "array", foreignHoldings: "value", investorNetShares: "value", institutionCumulative: "array",
  dart: "value", fred: "array", valuation: "array", returnDecomposition: "value", corrections: "array", missing: "array", limitations: "array",
} satisfies Record<keyof Bundle, "value" | "array">;
export const BUNDLE_FIELDS = Object.keys(BUNDLE_LAYOUT) as Array<keyof typeof BUNDLE_LAYOUT>;
export const PAGE_BYTES = 16 * 1024 * 1024;
export interface DocumentField { key: typeof BUNDLE_FIELDS[number]; kind: "value" | "array"; length: number; pages: number }
export interface BundleManifest { kind: "manifest"; format: "leader-cases/paged-bundle"; schemaVersion: 2; encoding: "gzip-base64"; fields: DocumentField[] }
export interface BundlePage { kind: "page"; field: string; index: number; bytes: number; data: string }
export interface BundleDocument { manifest: BundleManifest; pages: BundlePage[] }
export type InflatePage = (data: string, bytes: number) => Promise<string>;

export function parseManifest(input: unknown): BundleManifest {
  const value = fields(input);
  if (value.kind !== "manifest" || value.format !== "leader-cases/paged-bundle" || value.schemaVersion !== 2 || value.encoding !== "gzip-base64") throw new Error("invalid_bundle_manifest");
  const descriptors = list(value.fields).map((item, i): DocumentField => {
    const f = fields(item), key = BUNDLE_FIELDS[i];
    if (!key || f.key !== key || f.kind !== BUNDLE_LAYOUT[key]) throw new Error("invalid_bundle_field_order");
    const length = integer(f.length), pages = integer(f.pages);
    if (length < 0 || pages < 0 || (f.kind === "value" && (length !== 1 || pages !== 1)) || (f.kind === "array" && ((length === 0) !== (pages === 0) || pages > length))) throw new Error("invalid_bundle_field_count");
    return { key, kind: BUNDLE_LAYOUT[key], length, pages };
  });
  if (descriptors.length !== BUNDLE_FIELDS.length) throw new Error("missing_bundle_field");
  return { kind: "manifest", format: "leader-cases/paged-bundle", schemaVersion: 2, encoding: "gzip-base64", fields: descriptors };
}
export function parsePage(input: unknown): BundlePage {
  const value = fields(input), index = integer(value.index), bytes = integer(value.bytes), data = text(value.data);
  if (value.kind !== "page" || index < 0 || bytes < 1 || bytes > PAGE_BYTES || data.length > PAGE_BYTES * 2 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("invalid_bundle_page");
  return { kind: "page", field: text(value.field), index, bytes, data };
}
export function validateDocument(document: BundleDocument): BundleDocument {
  const manifest = parseManifest(document.manifest);
  let cursor = 0;
  for (const f of manifest.fields) for (let index = 0; index < f.pages; index++) {
    const page = parsePage(document.pages[cursor++]);
    if (page.field !== f.key || page.index !== index) throw new Error("invalid_bundle_page_order");
  }
  if (cursor !== document.pages.length) throw new Error("unexpected_bundle_page");
  return document;
}
export async function decodeDocument(document: BundleDocument, inflate: InflatePage, parse: (key: DocumentField["key"], value: unknown) => unknown): Promise<unknown> {
  validateDocument(document);
  const result: Record<string, unknown> = {};
  let cursor = 0;
  for (const f of document.manifest.fields) {
    const items: unknown[] = [];
    for (let index = 0; index < f.pages; index++) {
      const page = document.pages[cursor++]!;
      let payload: Record<string, unknown>;
      try { payload = fields(JSON.parse(await inflate(page.data, page.bytes))); } catch { throw new Error("bundle_page_decode_failed"); }
      if (payload.field !== f.key || payload.index !== index) throw new Error("bundle_page_identity_mismatch");
      const value = parse(f.key, payload.value);
      if (f.kind === "value") result[f.key] = value;
      else {
        const rows = list(value);
        if (!rows.length) throw new Error("empty_bundle_page");
        for (const item of rows) items.push(item);
      }
    }
    if (f.kind === "array") {
      if (items.length !== f.length) throw new Error("bundle_array_length_mismatch");
      result[f.key] = items;
    }
  }
  return result;
}
export async function inflateBrowserPage(data: string, bytes: number): Promise<string> {
  const binary = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const reader = new Blob([binary]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, json = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > bytes || size > PAGE_BYTES) throw new Error("bundle_page_size_mismatch");
      json += decoder.decode(chunk.value, { stream: true });
    }
    json += decoder.decode();
    if (size !== bytes) throw new Error("bundle_page_size_mismatch");
    return json;
  } finally { await reader.cancel(); reader.releaseLock(); }
}
