import { crc32, gzipSync, gunzipSync } from "node:zlib";
import type { BundleDocument, BundlePage } from "../bundle-document.ts";

export const GZIP_DAMAGE = ["trailing-zero", "trailing-garbage", "split-members", "empty-member"] as const;
export type GzipDamage = typeof GZIP_DAMAGE[number];
export function gzipWithOptionalHeader(page: BundlePage): BundlePage {
  const gzip = Buffer.from(page.data, "base64"), fixed = Buffer.from(gzip.subarray(0, 10));
  fixed[3] = 31;
  const header = Buffer.concat([fixed, Buffer.from([3, 0, 7, 8, 9]), Buffer.from("fixture.json\0header comment\0")]);
  const checksum = Buffer.alloc(2); checksum.writeUInt16LE(crc32(header) & 65535);
  return { ...page, data: Buffer.concat([header, checksum, gzip.subarray(10)]).toString("base64") };
}
export function damagedGzipPage(page: BundlePage, kind: GzipDamage): BundlePage {
  const gzip = Buffer.from(page.data, "base64");
  const raw = gunzipSync(gzip);
  const damaged = kind === "trailing-zero" ? Buffer.concat([gzip, Buffer.from([0])])
    : kind === "trailing-garbage" ? Buffer.concat([gzip, Buffer.from("\0SYNTHETIC-PRIVATE-MARKER")])
    : kind === "empty-member" ? Buffer.concat([gzip, gzipSync("")])
    : Buffer.concat([gzipSync(raw.subarray(0, 10)), gzipSync(raw.subarray(10))]);
  return { ...page, data: damaged.toString("base64") };
}
export function damagedGzipDocument(document: BundleDocument, index: number, kind: GzipDamage): BundleDocument {
  return { ...document, pages: document.pages.map((p, i) => i === index ? damagedGzipPage(p, kind) : p) };
}
