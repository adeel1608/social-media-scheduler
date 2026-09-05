import type { Env } from "./env";

interface DisconnectConfirmation {
  accountId: string;
  ownerId: string;
  expiresAt: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function signingKey(env: Env): Promise<CryptoKey> {
  const secret = Uint8Array.from(atob(env.TOKEN_ENCRYPTION_KEY), (character) =>
    character.charCodeAt(0),
  );
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signature(env: Env, payload: string): Promise<Uint8Array> {
  const signed = await crypto.subtle.sign(
    "HMAC",
    await signingKey(env),
    toArrayBuffer(
      encoder.encode(`postline-disconnect-confirmation-v1\n${payload}`),
    ),
  );
  return new Uint8Array(signed);
}

export async function createDisconnectConfirmation(
  env: Env,
  accountId: string,
  ownerId: string,
  now = Date.now(),
): Promise<string> {
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        accountId,
        ownerId,
        expiresAt: Math.floor(now / 1_000) + 10 * 60,
      } satisfies DisconnectConfirmation),
    ),
  );
  return `v1.${payload}.${base64UrlEncode(await signature(env, payload))}`;
}

export async function verifyDisconnectConfirmation(
  env: Env,
  token: string,
  expectedAccountId: string,
  expectedOwnerId: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    const [version, encoded, suppliedSignature, extra] = token.split(".");
    if (version !== "v1" || !encoded || !suppliedSignature || extra)
      return false;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(env),
      toArrayBuffer(base64UrlDecode(suppliedSignature)),
      toArrayBuffer(
        encoder.encode(`postline-disconnect-confirmation-v1\n${encoded}`),
      ),
    );
    if (!valid) return false;
    const payload = JSON.parse(
      decoder.decode(base64UrlDecode(encoded)),
    ) as Partial<DisconnectConfirmation>;
    const nowSeconds = Math.floor(now / 1_000);
    return (
      payload.accountId === expectedAccountId &&
      payload.ownerId === expectedOwnerId &&
      typeof payload.expiresAt === "number" &&
      Number.isSafeInteger(payload.expiresAt) &&
      payload.expiresAt >= nowSeconds &&
      payload.expiresAt <= nowSeconds + 10 * 60
    );
  } catch {
    return false;
  }
}
