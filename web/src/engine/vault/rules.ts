export const KEY_LIMIT = 5;
export const ALIAS_MAX_LENGTH = 20;
export const PASSWORD_MIN_LENGTH = 8;
export const FORMAT_VERSION = 1;

export type VaultBroker = "kiwoom";
export type LockMode = "auto" | "password";

export type VaultErrorCode =
  | "limit"
  | "duplicate_app_key"
  | "alias_length"
  | "empty_credentials"
  | "unknown_key"
  | "unsupported_broker"
  | "password_too_short"
  | "wrong_password"
  | "locked"
  | "wrong_lock_mode"
  | "key_lost"
  | "unreadable"
  | "unsupported_format"
  | "missing_value";

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode) {
    super(code);
    this.name = "VaultError";
  }
}

const keyNumber = (keyId: string): number => Number(keyId.slice(1));

export function nextKeyId(keyIds: readonly string[]): string {
  return `k${Math.max(0, ...keyIds.map(keyNumber)) + 1}`;
}

export const byKeyNumber = <T extends { keyId: string }>(keys: readonly T[]): T[] => [...keys].sort((a, b) => keyNumber(a.keyId) - keyNumber(b.keyId));

export function checkedAlias(alias: string): string {
  const trimmed = alias.trim();
  if (trimmed.length < 1 || [...trimmed].length > ALIAS_MAX_LENGTH) throw new VaultError("alias_length");
  return trimmed;
}

export function checkedCredentials(appKey: string, appSecret: string): { appKey: string; appSecret: string } {
  const credentials = { appKey: appKey.trim(), appSecret: appSecret.trim() };
  if (credentials.appKey === "" || credentials.appSecret === "") throw new VaultError("empty_credentials");
  return credentials;
}

export function checkedBroker(broker: string): VaultBroker {
  if (broker !== "kiwoom") throw new VaultError("unsupported_broker");
  return broker;
}

export function checkedPassword(password: string): string {
  if ([...password].length < PASSWORD_MIN_LENGTH) throw new VaultError("password_too_short");
  return password;
}

const MASK_DOTS = "••••••••••••";

export const maskAppKey = (appKey: string): string => (appKey.length >= 12 ? `${MASK_DOTS}${appKey.slice(-4)}` : MASK_DOTS);

export function marketKeyIdOf(keyIds: readonly string[], stored: string | null): string | null {
  if (stored !== null && keyIds.includes(stored)) return stored;
  return keyIds[0] ?? null;
}
