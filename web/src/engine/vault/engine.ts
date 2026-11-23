import { type KeySecrets, SECRETS } from "./internals";
import type { Vault } from "./vault";

export type { KeySecrets };

export const readKeySecrets = (vault: Vault, keyId: string): Promise<KeySecrets> => vault[SECRETS]().keySecrets(keyId);

export const readAllKeySecrets = (vault: Vault): Promise<KeySecrets[]> => vault[SECRETS]().allKeySecrets();

export const sealNamedValue = (vault: Vault, name: string, plaintext: string): Promise<void> => vault[SECRETS]().sealValue(name, plaintext);

export const openNamedValue = (vault: Vault, name: string): Promise<string> => vault[SECRETS]().openValue(name);

export const removeNamedValue = (vault: Vault, name: string): Promise<void> => vault[SECRETS]().removeValue(name);
