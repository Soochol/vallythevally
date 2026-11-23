import { VaultError } from "./rules";

export interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  data: Uint8Array<ArrayBuffer>;
}

const AES = { name: "AES-GCM", length: 256 } as const;
const IV_BYTES = 12;
const SALT_BYTES = 16;
export const PBKDF2_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const newAutoKey = (): Promise<CryptoKey> => crypto.subtle.generateKey(AES, false, ["encrypt", "decrypt"]);

export const newSalt = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(SALT_BYTES));

export async function passwordKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, AES, false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, plaintext: string, context: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, key, encoder.encode(plaintext));
  return { iv, data: new Uint8Array(data) };
}

export async function open(key: CryptoKey, sealed: Sealed, context: string): Promise<string> {
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv, additionalData: encoder.encode(context) }, key, sealed.data);
    return decoder.decode(plain);
  } catch {
    throw new VaultError("unreadable");
  }
}
