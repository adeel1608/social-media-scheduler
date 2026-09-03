export interface EncryptedValue {
  ciphertext: string;
  nonce: string;
  algorithm: "AES-GCM";
  keyVersion: string;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const bytes = fromBase64(keyBase64);
  if (bytes.byteLength !== 32)
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(bytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(
  plaintext: string,
  keyBase64: string,
  keyVersion = "v1",
): Promise<EncryptedValue> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(keyBase64);
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    encoded,
  );
  return {
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    nonce: toBase64(nonce),
    algorithm: "AES-GCM",
    keyVersion,
  };
}

export async function decryptSecret(
  value: EncryptedValue,
  keyBase64: string,
): Promise<string> {
  if (value.algorithm !== "AES-GCM")
    throw new Error("Unsupported token encryption algorithm");
  const key = await importKey(keyBase64);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(fromBase64(value.nonce)) },
    key,
    toArrayBuffer(fromBase64(value.ciphertext)),
  );
  return new TextDecoder().decode(plaintext);
}
