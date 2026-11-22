import { newAutoKey, newSalt, open, PBKDF2_ITERATIONS, passwordKey, type Sealed, seal } from "./crypto";
import { type KeySecrets, SECRETS, type SecretAccess } from "./internals";
import {
  byKeyNumber,
  checkedAlias,
  checkedBroker,
  checkedCredentials,
  checkedPassword,
  FORMAT_VERSION,
  KEY_LIMIT,
  type LockMode,
  marketKeyIdOf,
  maskAppKey,
  nextKeyId,
  VaultError,
  type VaultBroker,
} from "./rules";
import type { StoreWrite, VaultStore } from "./store";

export interface KeyView {
  keyId: string;
  alias: string;
  broker: VaultBroker;
  maskedAppKey: string;
  market: boolean;
}

export interface VaultView {
  lock: LockMode;
  locked: boolean;
  limit: number;
  keys: KeyView[];
}

export interface NewKey {
  alias: string;
  broker: string;
  appKey: string;
  appSecret: string;
}

export interface KeyChange {
  alias?: string;
  credentials?: { appKey: string; appSecret: string };
}

interface PasswordParams {
  salt: Uint8Array<ArrayBuffer>;
  iterations: number;
  check: Sealed;
}

interface Meta {
  v: number;
  lock: LockMode;
  marketKeyId: string | null;
  password: PasswordParams | null;
}

interface KeyRecord {
  keyId: string;
  alias: string;
  broker: VaultBroker;
  maskedAppKey: string;
  appKey: Sealed;
  appSecret: Sealed;
}

interface Snapshot {
  meta: Meta;
  autoKey: CryptoKey | null;
  keys: KeyRecord[];
  values: Map<string, Sealed>;
}

const META = "meta";
const AUTO_KEY = "auto-key";
const KEY_PREFIX = "key:";
const VALUE_PREFIX = "value:";
const CHECK_TEXT = "vally-key-vault-check";
const CHECK_CONTEXT = "check";

const EMPTY_META: Meta = { v: FORMAT_VERSION, lock: "auto", marketKeyId: null, password: null };

const appKeyContext = (keyId: string) => `${KEY_PREFIX}${keyId}:appKey`;
const appSecretContext = (keyId: string) => `${KEY_PREFIX}${keyId}:appSecret`;
const valueContext = (name: string) => `${VALUE_PREFIX}${name}`;

const saltId = (salt: Uint8Array): string => Array.from(salt, (byte) => byte.toString(16).padStart(2, "0")).join("");
const lockId = (meta: Meta): string => (meta.password ? saltId(meta.password.salt) : "auto");

function parse(records: ReadonlyMap<string, unknown>): Snapshot {
  const meta = (records.get(META) as Meta | undefined) ?? EMPTY_META;
  if (meta.v !== FORMAT_VERSION) throw new VaultError("unsupported_format");
  const keys: KeyRecord[] = [];
  const values = new Map<string, Sealed>();
  for (const [name, record] of records) {
    if (name.startsWith(KEY_PREFIX)) keys.push(record as KeyRecord);
    else if (name.startsWith(VALUE_PREFIX)) values.set(name.slice(VALUE_PREFIX.length), record as Sealed);
  }
  return { meta, autoKey: (records.get(AUTO_KEY) as CryptoKey | undefined) ?? null, keys: byKeyNumber(keys), values };
}

export class Vault {
  private unlocked: { lockId: string; key: CryptoKey } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: VaultStore) {}

  view(): Promise<VaultView> {
    return this.run(async () => this.viewOf(await this.snapshot()));
  }

  addKey(input: NewKey): Promise<VaultView> {
    return this.run(async () => {
      const alias = checkedAlias(input.alias);
      const broker = checkedBroker(input.broker);
      const credentials = checkedCredentials(input.appKey, input.appSecret);
      const snap = await this.snapshot();
      if (snap.keys.length >= KEY_LIMIT) throw new VaultError("limit");
      const key = await this.writeKey(snap);
      await this.rejectDuplicateAppKey(snap, key, credentials.appKey, null);
      const keyId = nextKeyId(snap.keys.map((record) => record.keyId));
      const record: KeyRecord = {
        keyId,
        alias,
        broker,
        maskedAppKey: maskAppKey(credentials.appKey),
        appKey: await seal(key, credentials.appKey, appKeyContext(keyId)),
        appSecret: await seal(key, credentials.appSecret, appSecretContext(keyId)),
      };
      await this.store.write([{ put: `${KEY_PREFIX}${keyId}`, value: record }]);
      return this.view0();
    });
  }

  updateKey(keyId: string, change: KeyChange): Promise<VaultView> {
    return this.run(async () => {
      const snap = await this.snapshot();
      const current = this.keyRecord(snap, keyId);
      const alias = change.alias === undefined ? current.alias : checkedAlias(change.alias);
      let next: KeyRecord = { ...current, alias };
      if (change.credentials) {
        const credentials = checkedCredentials(change.credentials.appKey, change.credentials.appSecret);
        const key = await this.writeKey(snap);
        await this.rejectDuplicateAppKey(snap, key, credentials.appKey, keyId);
        next = {
          ...next,
          maskedAppKey: maskAppKey(credentials.appKey),
          appKey: await seal(key, credentials.appKey, appKeyContext(keyId)),
          appSecret: await seal(key, credentials.appSecret, appSecretContext(keyId)),
        };
      }
      await this.store.write([{ put: `${KEY_PREFIX}${keyId}`, value: next }]);
      return this.view0();
    });
  }

  removeKey(keyId: string): Promise<VaultView> {
    return this.run(async () => {
      const snap = await this.snapshot();
      this.keyRecord(snap, keyId);
      const ops: StoreWrite[] = [{ remove: `${KEY_PREFIX}${keyId}` }];
      if (snap.meta.marketKeyId === keyId) ops.push({ put: META, value: { ...snap.meta, marketKeyId: null } });
      await this.store.write(ops);
      return this.view0();
    });
  }

  setMarketKey(keyId: string): Promise<VaultView> {
    return this.run(async () => {
      const snap = await this.snapshot();
      this.keyRecord(snap, keyId);
      await this.store.write([{ put: META, value: { ...snap.meta, marketKeyId: keyId } }]);
      return this.view0();
    });
  }

  enablePassword(password: string): Promise<VaultView> {
    return this.run(async () => {
      checkedPassword(password);
      const snap = await this.snapshot();
      if (snap.meta.lock !== "auto") throw new VaultError("wrong_lock_mode");
      const from = this.hasSecrets(snap) ? this.requireAutoKey(snap) : null;
      const salt = newSalt();
      const to = await passwordKey(password, salt, PBKDF2_ITERATIONS);
      const params: PasswordParams = { salt, iterations: PBKDF2_ITERATIONS, check: await seal(to, CHECK_TEXT, CHECK_CONTEXT) };
      const meta: Meta = { ...snap.meta, lock: "password", password: params };
      const ops = [...(from ? await this.resealAll(snap, from, to) : []), { put: META, value: meta }, { remove: AUTO_KEY }];
      await this.store.write(ops);
      this.unlocked = { lockId: lockId(meta), key: to };
      return this.view0();
    });
  }

  unlock(password: string): Promise<VaultView> {
    return this.run(async () => {
      const snap = await this.snapshot();
      const key = await this.verifiedPasswordKey(snap, password);
      this.unlocked = { lockId: lockId(snap.meta), key };
      return this.view0();
    });
  }

  lock(): Promise<VaultView> {
    return this.run(async () => {
      this.unlocked = null;
      return this.view0();
    });
  }

  disablePassword(password: string): Promise<VaultView> {
    return this.run(async () => {
      const snap = await this.snapshot();
      const from = await this.verifiedPasswordKey(snap, password);
      const to = await newAutoKey();
      const meta: Meta = { ...snap.meta, lock: "auto", password: null };
      const ops = [...(await this.resealAll(snap, from, to)), { put: AUTO_KEY, value: to }, { put: META, value: meta }];
      await this.store.write(ops);
      this.unlocked = null;
      return this.view0();
    });
  }

  wipe(): Promise<VaultView> {
    return this.run(async () => {
      this.unlocked = null;
      await this.store.destroy();
      return this.view0();
    });
  }

  [SECRETS](): SecretAccess {
    const unseal = async (key: CryptoKey, record: KeyRecord): Promise<KeySecrets> => ({
      keyId: record.keyId,
      appKey: await open(key, record.appKey, appKeyContext(record.keyId)),
      appSecret: await open(key, record.appSecret, appSecretContext(record.keyId)),
    });
    return {
      keySecrets: (keyId) =>
        this.run(async () => {
          const snap = await this.snapshot();
          return unseal(this.readKey(snap), this.keyRecord(snap, keyId));
        }),
      allKeySecrets: () =>
        this.run(async () => {
          const snap = await this.snapshot();
          const key = this.readKey(snap);
          return Promise.all(snap.keys.map((record) => unseal(key, record)));
        }),
      sealValue: (name, plaintext) =>
        this.run(async () => {
          const snap = await this.snapshot();
          const key = await this.writeKey(snap);
          await this.store.write([{ put: `${VALUE_PREFIX}${name}`, value: await seal(key, plaintext, valueContext(name)) }]);
        }),
      openValue: (name) =>
        this.run(async () => {
          const snap = await this.snapshot();
          const key = this.readKey(snap);
          const sealed = snap.values.get(name);
          if (!sealed) throw new VaultError("missing_value");
          return open(key, sealed, valueContext(name));
        }),
      removeValue: (name) => this.run(() => this.store.write([{ remove: `${VALUE_PREFIX}${name}` }])),
    };
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async view0(): Promise<VaultView> {
    return this.viewOf(await this.snapshot());
  }

  private async snapshot(): Promise<Snapshot> {
    const snap = parse(await this.store.readAll());
    if (this.unlocked && (snap.meta.lock !== "password" || this.unlocked.lockId !== lockId(snap.meta))) this.unlocked = null;
    return snap;
  }

  private viewOf(snap: Snapshot): VaultView {
    const market = marketKeyIdOf(snap.keys.map((record) => record.keyId), snap.meta.marketKeyId);
    return {
      lock: snap.meta.lock,
      locked: snap.meta.lock === "password" && this.unlocked === null,
      limit: KEY_LIMIT,
      keys: snap.keys.map((record) => ({ keyId: record.keyId, alias: record.alias, broker: record.broker, maskedAppKey: record.maskedAppKey, market: record.keyId === market })),
    };
  }

  private keyRecord(snap: Snapshot, keyId: string): KeyRecord {
    const record = snap.keys.find((candidate) => candidate.keyId === keyId);
    if (!record) throw new VaultError("unknown_key");
    return record;
  }

  private hasSecrets(snap: Snapshot): boolean {
    return snap.keys.length > 0 || snap.values.size > 0;
  }

  private requireAutoKey(snap: Snapshot): CryptoKey {
    if (!snap.autoKey) throw new VaultError("key_lost");
    return snap.autoKey;
  }

  private readKey(snap: Snapshot): CryptoKey {
    if (snap.meta.lock === "password") {
      if (!this.unlocked) throw new VaultError("locked");
      return this.unlocked.key;
    }
    return this.requireAutoKey(snap);
  }

  private async writeKey(snap: Snapshot): Promise<CryptoKey> {
    if (snap.meta.lock === "password" || snap.autoKey || this.hasSecrets(snap)) return this.readKey(snap);
    return (await this.store.createIfAbsent(AUTO_KEY, await newAutoKey())) as CryptoKey;
  }

  private async rejectDuplicateAppKey(snap: Snapshot, key: CryptoKey, appKey: string, except: string | null): Promise<void> {
    for (const record of snap.keys) {
      if (record.keyId !== except && (await open(key, record.appKey, appKeyContext(record.keyId))) === appKey) throw new VaultError("duplicate_app_key");
    }
  }

  private async verifiedPasswordKey(snap: Snapshot, password: string): Promise<CryptoKey> {
    const params = snap.meta.password;
    if (snap.meta.lock !== "password" || !params) throw new VaultError("wrong_lock_mode");
    const key = await passwordKey(password, params.salt, params.iterations);
    const check = await open(key, params.check, CHECK_CONTEXT).catch(() => null);
    if (check !== CHECK_TEXT) throw new VaultError("wrong_password");
    return key;
  }

  private async resealAll(snap: Snapshot, from: CryptoKey, to: CryptoKey): Promise<StoreWrite[]> {
    const ops: StoreWrite[] = [];
    for (const record of snap.keys) {
      const next: KeyRecord = {
        ...record,
        appKey: await seal(to, await open(from, record.appKey, appKeyContext(record.keyId)), appKeyContext(record.keyId)),
        appSecret: await seal(to, await open(from, record.appSecret, appSecretContext(record.keyId)), appSecretContext(record.keyId)),
      };
      ops.push({ put: `${KEY_PREFIX}${record.keyId}`, value: next });
    }
    for (const [name, sealed] of snap.values) {
      ops.push({ put: `${VALUE_PREFIX}${name}`, value: await seal(to, await open(from, sealed, valueContext(name)), valueContext(name)) });
    }
    return ops;
  }
}
