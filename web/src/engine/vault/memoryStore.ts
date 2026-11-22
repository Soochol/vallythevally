import type { StoreWrite, VaultStore } from "./store";

export interface MemoryStore extends VaultStore {
  readonly records: Map<string, unknown>;
}

export function memoryStore(): MemoryStore {
  const records = new Map<string, unknown>();
  return {
    records,
    async readAll() {
      return new Map([...records].map(([key, value]) => [key, structuredClone(value)]));
    },
    async createIfAbsent(key, value) {
      if (!records.has(key)) records.set(key, structuredClone(value));
      return structuredClone(records.get(key));
    },
    async write(ops: readonly StoreWrite[]) {
      for (const op of ops) {
        if ("put" in op) records.set(op.put, structuredClone(op.value));
        else records.delete(op.remove);
      }
    },
    async destroy() {
      records.clear();
    },
  };
}
