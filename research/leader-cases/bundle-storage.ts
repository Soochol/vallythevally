import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { crc32, gzip, inflateRaw } from "node:zlib";
import type { Bundle } from "./bundle-types.ts";
import { BUNDLE_FIELDS, PAGE_BYTES, parseManifest, parsePage, validateDocument, type BundleDocument, type BundlePage, type DocumentField } from "./bundle-document.ts";
import { parseDocumentBundle } from "./report-input.ts";
import { fields, integer } from "./source-utils.ts";

const compress = promisify(gzip), decompress = promisify(inflateRaw);
export async function encodeBundle(bundle: Bundle): Promise<BundleDocument> {
  const pages: BundlePage[] = [], descriptors: DocumentField[] = [];
  for (const key of BUNDLE_FIELDS) {
    const value = bundle[key];
    const descriptor: DocumentField = { key, kind: Array.isArray(value) ? "array" : "value", length: Array.isArray(value) ? value.length : 1, pages: 0 };
    const count = key === "prices" || key === "sectors" ? 1 : 128;
    const values = Array.isArray(value) ? Array.from({ length: Math.ceil(value.length / count) }, (_, i) => value.slice(i * count, (i + 1) * count)) : [value];
    for (const part of values) {
      let json: string;
      try { json = JSON.stringify({ field: key, index: descriptor.pages, value: part }); } catch { throw new Error("bundle_page_serialize_failed"); }
      const bytes = Buffer.byteLength(json);
      if (bytes > PAGE_BYTES) throw new Error("bundle_page_too_large");
      const data = (await compress(json)).toString("base64");
      pages.push({ kind: "page", field: key, index: descriptor.pages++, bytes, data });
    }
    descriptors.push(descriptor);
  }
  return { manifest: { kind: "manifest", format: "leader-cases/paged-bundle", schemaVersion: 2, encoding: "gzip-base64", fields: descriptors }, pages };
}
export async function inflateNodePage(data: string, bytes: number): Promise<string> {
  const gzip = Buffer.from(data, "base64");
  const offset = gzipPayloadOffset(gzip);
  const inflated: unknown = await decompress(gzip.subarray(offset), { maxOutputLength: PAGE_BYTES, info: true });
  const response = fields(inflated), result = response.buffer;
  if (!Buffer.isBuffer(result)) throw new Error("invalid_inflate_result");
  const consumed = integer(fields(response.engine).bytesWritten);
  const trailer = offset + consumed;
  if (trailer + 8 !== gzip.length) throw new Error("gzip_residual_bytes_or_multiple_members");
  if (crc32(result) !== gzip.readUInt32LE(trailer) || result.length !== gzip.readUInt32LE(trailer + 4)) throw new Error("gzip_checksum_or_size_mismatch");
  if (result.length !== bytes) throw new Error("bundle_page_size_mismatch");
  return new TextDecoder("utf-8", { fatal: true }).decode(result);
}
function gzipPayloadOffset(gzip: Buffer): number {
  if (gzip.length < 18 || gzip[0] !== 31 || gzip[1] !== 139 || gzip[2] !== 8 || (gzip[3]! & 224) !== 0) throw new Error("invalid_gzip_header");
  const flags = gzip[3]!, end = gzip.length - 8;
  let offset = 10;
  if (flags & 4) {
    if (offset + 2 > end) throw new Error("truncated_gzip_header");
    offset += 2 + gzip.readUInt16LE(offset);
    if (offset > end) throw new Error("truncated_gzip_header");
  }
  for (const flag of [8, 16]) if (flags & flag) {
    const nul = gzip.indexOf(0, offset);
    if (nul === -1 || nul >= end) throw new Error("truncated_gzip_header");
    offset = nul + 1;
  }
  if (flags & 2) {
    if (offset + 2 > end || (crc32(gzip.subarray(0, offset)) & 65535) !== gzip.readUInt16LE(offset)) throw new Error("invalid_gzip_header_checksum");
    offset += 2;
  }
  if (offset >= end) throw new Error("truncated_gzip_payload");
  return offset;
}
export async function documentBundle(document: BundleDocument): Promise<Bundle> {
  return parseDocumentBundle(document, inflateNodePage);
}
export function* documentChunks(document: BundleDocument): Generator<string> {
  validateDocument(document);
  yield "[\n" + JSON.stringify(document.manifest);
  for (const page of document.pages) yield ",\n" + JSON.stringify(page);
  yield "\n]\n";
}
export async function writeAtomic(output: string, contents: Iterable<string> | AsyncIterable<string>): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(contents); await file.close(); await rename(temporary, output);
  } finally { await file.close(); await rm(temporary, { force: true }); }
}
export async function writeBundle(output: string, bundle: Bundle): Promise<BundleDocument> {
  const document = await encodeBundle(bundle);
  await writeAtomic(output, documentChunks(document));
  return document;
}
export async function readBundleDocument(filename: string): Promise<BundleDocument> {
  const input = createReadStream(filename, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  let started = false, ended = false, manifest: BundleDocument["manifest"] | null = null, comma = false;
  const pages: BundlePage[] = [];
  try {
    for await (const line of reader) {
      const value = line.trim();
      if (!value) continue;
      if (!started) { if (value !== "[") throw new Error("invalid_bundle_document_start"); started = true; continue; }
      if (ended) throw new Error("trailing_bundle_document_data");
      if (value === "]") { if (comma || !manifest) throw new Error("invalid_bundle_document_end"); ended = true; continue; }
      if (manifest && !comma) throw new Error("missing_bundle_document_comma");
      comma = value.endsWith(",");
      const item: unknown = JSON.parse(comma ? value.slice(0, -1) : value);
      if (!manifest) manifest = parseManifest(item);
      else pages.push(parsePage(item));
    }
  } finally { reader.close(); input.destroy(); }
  if (!ended || !manifest) throw new Error("truncated_bundle_document");
  return validateDocument({ manifest, pages });
}
export async function readBundle(filename: string): Promise<Bundle> { return documentBundle(await readBundleDocument(filename)); }
