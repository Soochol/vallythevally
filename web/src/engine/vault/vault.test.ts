import { describe, expect, it } from "vitest";
import { readAllKeySecrets, readKeySecrets, openNamedValue, sealNamedValue } from "./engine";
import { memoryStore, type MemoryStore } from "./memoryStore";
import { Vault, VaultError } from "./index";

const APP_KEY = "AK-0123456789-abcdefghij";
const APP_SECRET = "SK-secret-value-9876543210-zyx";
const PASSWORD = "correct horse battery";

const key = (n: number, alias = `키 ${n}`) => ({ alias, broker: "kiwoom", appKey: `AK-${n}-0123456789-abcdef`, appSecret: `SK-${n}-secret-value` });
const fresh = () => {
  const store = memoryStore();
  return { store, vault: new Vault(store) };
};
const reopen = (store: MemoryStore) => new Vault(store);
const code = async (task: Promise<unknown>) => task.then(() => null, (e: unknown) => (e instanceof VaultError ? e.code : "other"));

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function dump(store: MemoryStore): string {
  const parts: string[] = [];
  const walk = (value: unknown) => {
    if (value instanceof Uint8Array) {
      parts.push(new TextDecoder("latin1").decode(value), btoa(String.fromCharCode(...value)), hex(value), new TextDecoder().decode(value));
    } else if (value && typeof value === "object" && !(value instanceof CryptoKey)) Object.values(value).forEach(walk);
    else if (typeof value === "string") parts.push(value);
  };
  for (const [name, value] of store.records) {
    parts.push(name);
    walk(value);
  }
  return parts.join("\n");
}

describe("자동 잠금", () => {
  it("다시 열면 입력 없이 같은 키가 나온다", async () => {
    const { store, vault } = fresh();
    await vault.addKey({ alias: "내 키", broker: "kiwoom", appKey: APP_KEY, appSecret: APP_SECRET });
    const again = reopen(store);
    expect((await again.view()).keys.map((k) => k.alias)).toEqual(["내 키"]);
    expect(await readKeySecrets(again, "k1")).toEqual({ keyId: "k1", appKey: APP_KEY, appSecret: APP_SECRET });
  });

  it("저장된 레코드 어디에도 앱키·시크릿 원문이 없다", async () => {
    const { store, vault } = fresh();
    await vault.addKey({ alias: "내 키", broker: "kiwoom", appKey: APP_KEY, appSecret: APP_SECRET });
    await sealNamedValue(vault, "token", "토큰-원문-12345");
    const text = dump(store);
    expect(text).toContain("내 키");
    for (const secret of [APP_KEY, APP_SECRET, "토큰-원문-12345"]) expect(text).not.toContain(secret);
  });

  it("저장된 CryptoKey는 꺼낼 수 없다", async () => {
    const { store, vault } = fresh();
    await vault.addKey(key(1));
    const stored = store.records.get("auto-key") as CryptoKey;
    expect(stored.extractable).toBe(false);
    expect(stored.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await expect(crypto.subtle.exportKey("raw", stored)).rejects.toThrow();
  });

  it("저장할 때마다 IV가 다르다", async () => {
    const { store, vault } = fresh();
    await vault.addKey(key(1));
    await vault.addKey(key(2));
    await sealNamedValue(vault, "token", "a");
    await sealNamedValue(vault, "token", "a");
    const ivs = [...store.records.values()].flatMap((record) => {
      const r = record as { appKey?: { iv: Uint8Array }; appSecret?: { iv: Uint8Array }; iv?: Uint8Array };
      return [r.appKey?.iv, r.appSecret?.iv, r.iv].filter((iv): iv is Uint8Array => iv !== undefined);
    });
    expect(ivs.length).toBe(5);
    expect(new Set(ivs.map((iv) => hex(iv))).size).toBe(ivs.length);
    for (const iv of ivs) expect(iv.length).toBe(12);
  });

  it("이름 붙은 값을 저장하고 읽고 지운다", async () => {
    const { store, vault } = fresh();
    await sealNamedValue(vault, "token:k1", "t-1");
    expect(await openNamedValue(reopen(store), "token:k1")).toBe("t-1");
    expect(await code(openNamedValue(vault, "none"))).toBe("missing_value");
  });

  it("저장 형식에 버전과 잠금 방식과 증권사 칸이 있다", async () => {
    const { store, vault } = fresh();
    await vault.addKey(key(1));
    expect((await vault.view()).lock).toBe("auto");
    expect((store.records.get("key:k1") as { broker: string }).broker).toBe("kiwoom");
    await vault.enablePassword(PASSWORD);
    expect(store.records.get("meta")).toMatchObject({ v: 1, lock: "password" });
  });
});

describe("잠금 비밀번호", () => {
  it("켠 뒤에는 자동 잠금 키가 없고 같은 비밀번호로 다시 열면 키가 같다", async () => {
    const { store, vault } = fresh();
    await vault.addKey({ alias: "내 키", broker: "kiwoom", appKey: APP_KEY, appSecret: APP_SECRET });
    await sealNamedValue(vault, "token", "토큰");
    await vault.enablePassword(PASSWORD);
    expect(store.records.has("auto-key")).toBe(false);
    expect(dump(store)).not.toContain(APP_SECRET);
    const again = reopen(store);
    expect((await again.view()).locked).toBe(true);
    await again.unlock(PASSWORD);
    expect(await readKeySecrets(again, "k1")).toEqual({ keyId: "k1", appKey: APP_KEY, appSecret: APP_SECRET });
    expect(await openNamedValue(again, "token")).toBe("토큰");
  });

  it("틀린 비밀번호로는 풀리지 않는다", async () => {
    const { store, vault } = fresh();
    await vault.addKey(key(1));
    await vault.enablePassword(PASSWORD);
    const again = reopen(store);
    expect(await code(again.unlock("wrong password"))).toBe("wrong_password");
    expect((await again.view()).locked).toBe(true);
    expect(await code(readKeySecrets(again, "k1"))).toBe("locked");
  });

  it("잠그면 시크릿을 꺼내는 함수가 실패한다", async () => {
    const { vault } = fresh();
    await vault.addKey(key(1));
    await vault.enablePassword(PASSWORD);
    expect((await readKeySecrets(vault, "k1")).appKey).toBe(key(1).appKey);
    await vault.lock();
    expect(await code(readKeySecrets(vault, "k1"))).toBe("locked");
    expect(await code(readAllKeySecrets(vault))).toBe("locked");
    expect(await code(vault.addKey(key(2)))).toBe("locked");
  });

  it("끄면 비밀번호를 확인한 뒤 자동 잠금으로 돌아가고 다시 열면 입력 없이 키가 나온다", async () => {
    const { store, vault } = fresh();
    await vault.addKey({ alias: "내 키", broker: "kiwoom", appKey: APP_KEY, appSecret: APP_SECRET });
    await vault.enablePassword(PASSWORD);
    expect(await code(vault.disablePassword("wrong password"))).toBe("wrong_password");
    await vault.disablePassword(PASSWORD);
    expect(store.records.has("auto-key")).toBe(true);
    expect((store.records.get("meta") as { password: unknown }).password).toBeNull();
    const again = reopen(store);
    expect((await again.view()).locked).toBe(false);
    expect(await readKeySecrets(again, "k1")).toEqual({ keyId: "k1", appKey: APP_KEY, appSecret: APP_SECRET });
    expect(dump(store)).not.toContain(APP_SECRET);
  });

  it("비밀번호는 8자 이상이고 어디에도 저장되지 않는다", async () => {
    const { store, vault } = fresh();
    expect(await code(vault.enablePassword("1234567"))).toBe("password_too_short");
    await vault.enablePassword(PASSWORD);
    expect(dump(store)).not.toContain(PASSWORD);
  });

  it("다른 탭이 비밀번호를 켜면 이 탭의 자동 잠금 키로는 쓰지 못한다", async () => {
    const { store, vault } = fresh();
    await vault.addKey(key(1));
    await reopen(store).enablePassword(PASSWORD);
    expect(await code(vault.addKey(key(2)))).toBe("locked");
    expect((await vault.view()).locked).toBe(true);
  });

  it("잠긴 동안에도 별칭 바꾸기·지우기·시세 키 고르기는 된다", async () => {
    const { vault } = fresh();
    await vault.addKey(key(1));
    await vault.addKey(key(2));
    await vault.enablePassword(PASSWORD);
    await vault.lock();
    await vault.updateKey("k2", { alias: "둘째" });
    await vault.setMarketKey("k2");
    expect((await vault.view()).keys.map((k) => [k.alias, k.market])).toEqual([["키 1", false], ["둘째", true]]);
    expect(await code(vault.updateKey("k1", { credentials: { appKey: "a", appSecret: "b" } }))).toBe("locked");
    expect((await vault.removeKey("k1")).keys).toHaveLength(1);
  });
});

describe("키 목록 규칙", () => {
  it("6번째 키는 거절된다", async () => {
    const { vault } = fresh();
    for (const n of [1, 2, 3, 4, 5]) await vault.addKey(key(n));
    expect(await code(vault.addKey(key(6)))).toBe("limit");
    expect((await vault.view()).keys).toHaveLength(5);
  });

  it("같은 앱키는 거절된다", async () => {
    const { vault } = fresh();
    await vault.addKey(key(1));
    expect(await code(vault.addKey({ ...key(2), appKey: key(1).appKey }))).toBe("duplicate_app_key");
    expect(await code(vault.updateKey("k1", { credentials: { appKey: key(1).appKey, appSecret: "새 시크릿" } }))).toBeNull();
    await vault.addKey(key(2));
    expect(await code(vault.updateKey("k2", { credentials: { appKey: key(1).appKey, appSecret: "x" } }))).toBe("duplicate_app_key");
  });

  it("별칭은 1~20자다", async () => {
    const { vault } = fresh();
    expect(await code(vault.addKey(key(1, "   ")))).toBe("alias_length");
    expect(await code(vault.addKey(key(1, "가".repeat(21))))).toBe("alias_length");
    expect(await code(vault.addKey(key(1, "가".repeat(20))))).toBeNull();
    expect(await code(vault.updateKey("k1", { alias: "" }))).toBe("alias_length");
  });

  it("지운 ID는 다시 쓰지 않고 새 ID는 남은 가장 큰 번호의 다음이다", async () => {
    const { vault } = fresh();
    for (const n of [1, 2, 3]) await vault.addKey(key(n));
    await vault.removeKey("k1");
    await vault.addKey(key(4));
    expect((await vault.view()).keys.map((k) => k.keyId)).toEqual(["k2", "k3", "k4"]);
  });

  it("시세 키는 기본이 첫 줄이고 바꿀 수 있다", async () => {
    const { vault } = fresh();
    await vault.addKey(key(1));
    await vault.addKey(key(2));
    const market = async () => (await vault.view()).keys.filter((k) => k.market).map((k) => k.keyId);
    expect(await market()).toEqual(["k1"]);
    await vault.setMarketKey("k2");
    expect(await market()).toEqual(["k2"]);
    expect(await code(vault.setMarketKey("k9"))).toBe("unknown_key");
  });

  it("시세 키를 지우면 첫 줄이 시세 키가 된다", async () => {
    const { vault } = fresh();
    for (const n of [1, 2, 3]) await vault.addKey(key(n));
    await vault.setMarketKey("k3");
    await vault.removeKey("k3");
    expect((await vault.view()).keys.find((k) => k.market)?.keyId).toBe("k1");
    await vault.addKey(key(4));
    expect((await vault.view()).keys.find((k) => k.market)?.keyId).toBe("k1");
  });

  it("앱키와 시크릿을 바꾸면 새 값이 나오고 가린 앱키가 따라 바뀐다", async () => {
    const { vault } = fresh();
    await vault.addKey({ alias: "내 키", broker: "kiwoom", appKey: APP_KEY, appSecret: APP_SECRET });
    const view = await vault.updateKey("k1", { credentials: { appKey: "NEW-APPKEY-1234567890", appSecret: "NEW-SECRET" } });
    expect(view.keys[0]!.maskedAppKey.endsWith("7890")).toBe(true);
    expect(await readKeySecrets(vault, "k1")).toMatchObject({ appKey: "NEW-APPKEY-1234567890", appSecret: "NEW-SECRET" });
  });

  it("증권사는 키움뿐이다", async () => {
    const { vault } = fresh();
    expect(await code(vault.addKey({ ...key(1), broker: "kis" }))).toBe("unsupported_broker");
  });

  it("모든 키 지우기는 처음 상태로 돌린다", async () => {
    const { store, vault } = fresh();
    await vault.addKey(key(1));
    await vault.enablePassword(PASSWORD);
    expect(await vault.wipe()).toMatchObject({ lock: "auto", locked: false, keys: [] });
    expect(store.records.size).toBe(0);
  });
});
