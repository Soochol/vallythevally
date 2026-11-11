export interface JsonSize { characters: number; bytes: number; objects: number; arrays: number; numbers: number }

export function jsonSizer(space = 0) {
  const cache = new WeakMap<object, Map<number, JsonSize>>();
  function size(value: unknown, depth = 0): JsonSize {
    if (value === null || typeof value !== "object") {
      const json = JSON.stringify(value);
      if (json === undefined) throw new Error("non_json_value");
      return { characters: json.length, bytes: Buffer.byteLength(json), objects: 0, arrays: 0, numbers: typeof value === "number" ? 1 : 0 };
    }
    const memoize = Array.isArray(value) || "sources" in value || "accountName" in value;
    const key = space ? depth : 0;
    const prior = memoize ? cache.get(value)?.get(key) : undefined;
    if (prior) return prior;
    const entries = Array.isArray(value) ? value.map((item) => [null, item] as const) : Object.entries(value);
    const result: JsonSize = { characters: 2, bytes: 2, objects: Array.isArray(value) ? 0 : 1, arrays: Array.isArray(value) ? 1 : 0, numbers: 0 };
    const addText = (s: string) => { result.characters += s.length; result.bytes += Buffer.byteLength(s); };
    entries.forEach(([name, item], i) => {
      if (i) addText(",");
      if (space) addText("\n" + " ".repeat((depth + 1) * space));
      if (name !== null) addText(JSON.stringify(name) + (space ? ": " : ":"));
      const nested = size(item, depth + 1);
      for (const field of ["characters", "bytes", "objects", "arrays", "numbers"] as const) result[field] += nested[field];
    });
    if (entries.length && space) addText("\n" + " ".repeat(depth * space));
    if (memoize) {
      const depths = cache.get(value) ?? new Map<number, JsonSize>();
      depths.set(key, result); cache.set(value, depths);
    }
    return result;
  }
  return size;
}
