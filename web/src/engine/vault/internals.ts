export const SECRETS = Symbol("vault.secrets");

export interface KeySecrets {
  keyId: string;
  appKey: string;
  appSecret: string;
}

export interface SecretAccess {
  keySecrets(keyId: string): Promise<KeySecrets>;
  allKeySecrets(): Promise<KeySecrets[]>;
  sealValue(name: string, plaintext: string): Promise<void>;
  openValue(name: string): Promise<string>;
  removeValue(name: string): Promise<void>;
}
