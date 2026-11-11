import { createHash } from "node:crypto";
import { BUNDLE_FIELDS } from "./bundle-document.ts";
import type { Bundle } from "./bundle-types.ts";

export function bundleFingerprint(bundle: Bundle): string {
  const hash = createHash("sha256");
  function add(value: unknown) {
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    });
    hash.update(`${json.length}:`); hash.update(json);
  }
  for (const key of BUNDLE_FIELDS) {
    add(key);
    const value = bundle[key];
    add(Array.isArray(value) ? value.length : null);
    for (const part of Array.isArray(value) ? value : [value]) add(part);
  }
  return hash.digest("hex");
}
