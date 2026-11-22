export type StoreWrite = { put: string; value: unknown } | { remove: string };

export interface VaultStore {
  readAll(): Promise<ReadonlyMap<string, unknown>>;
  createIfAbsent(key: string, value: unknown): Promise<unknown>;
  write(ops: readonly StoreWrite[]): Promise<void>;
  destroy(): Promise<void>;
}

const DATABASE = "vally-key-vault";
const OBJECTS = "records";

const settled = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export function indexedDbStore(factory: IDBFactory = indexedDB): VaultStore {
  let connection: Promise<IDBDatabase> | null = null;

  const connect = (): Promise<IDBDatabase> => {
    connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(OBJECTS);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const drop = () => {
          db.close();
          connection = null;
        };
        db.onversionchange = drop;
        db.onclose = () => { connection = null; };
        resolve(db);
      };
    });
    connection.catch(() => { connection = null; });
    return connection;
  };

  const transaction = async (mode: IDBTransactionMode) => {
    const tx = (await connect()).transaction(OBJECTS, mode);
    return { objects: tx.objectStore(OBJECTS), done: finished(tx) };
  };

  return {
    async readAll() {
      const { objects, done } = await transaction("readonly");
      const [keys, values] = await Promise.all([settled(objects.getAllKeys()), settled(objects.getAll()), done]);
      return new Map(keys.map((key, index) => [String(key), values[index]]));
    },
    async createIfAbsent(key, value) {
      const { objects, done } = await transaction("readwrite");
      const existing = await settled(objects.get(key));
      if (existing !== undefined) {
        await done;
        return existing;
      }
      objects.put(value, key);
      await done;
      return value;
    },
    async write(ops) {
      const { objects, done } = await transaction("readwrite");
      for (const op of ops) {
        if ("put" in op) objects.put(op.value, op.put);
        else objects.delete(op.remove);
      }
      await done;
    },
    async destroy() {
      const open = connection;
      connection = null;
      if (open) (await open.catch(() => null))?.close();
      await new Promise<void>((resolve, reject) => {
        const request = factory.deleteDatabase(DATABASE);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },
  };
}
