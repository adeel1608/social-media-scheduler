import { AwsClient } from "aws4fetch";

import {
  randomObjectKey,
  shouldUseMultipart,
  validateMedia,
} from "@scheduler/shared";

import type { Env } from "./env";

function extensionFor(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "bin";
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : "bin";
}

function s3Url(env: Env, objectKey: string): string {
  return `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}

function signer(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
}

const encoder = new TextEncoder();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deliverySignature(
  env: Env,
  encodedObjectKey: string,
  expires: number,
): Promise<string> {
  const secret = Uint8Array.from(atob(env.TOKEN_ENCRYPTION_KEY), (character) =>
    character.charCodeAt(0),
  );
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(encoder.encode("postline-media-delivery-v1")),
      info: toArrayBuffer(encoder.encode("provider-fetch-url")),
    },
    keyMaterial,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(encoder.encode(`${encodedObjectKey}\n${expires}`)),
  );
  return base64UrlEncode(new Uint8Array(signed));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export async function createUpload(
  env: Env,
  ownerId: string,
  input: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    width?: number | undefined;
    height?: number | undefined;
    durationSeconds?: number | undefined;
  },
) {
  const issues = validateMedia({
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    ...(input.width ? { width: input.width } : {}),
    ...(input.height ? { height: input.height } : {}),
  });
  if (issues.length) return { ok: false as const, issues };
  const objectKey = randomObjectKey(ownerId, extensionFor(input.filename));
  if (shouldUseMultipart(input.sizeBytes)) {
    const multipart = await env.MEDIA_BUCKET.createMultipartUpload(objectKey, {
      httpMetadata: { contentType: input.mimeType },
      customMetadata: { ownerId },
    });
    return {
      ok: true as const,
      mode: "multipart" as const,
      objectKey,
      uploadId: multipart.uploadId,
      partSize: 100 * 1024 * 1024,
    };
  }
  const directUrl = new URL(s3Url(env, objectKey));
  directUrl.searchParams.set("X-Amz-Expires", "900");
  const request = await signer(env).sign(directUrl.toString(), {
    method: "PUT",
    headers: { "Content-Type": input.mimeType },
    aws: { signQuery: true },
  });
  return {
    ok: true as const,
    mode: "single" as const,
    objectKey,
    uploadUrl: request.url,
    expiresIn: 900,
  };
}

export async function signMultipartPart(
  env: Env,
  input: { objectKey: string; uploadId: string; partNumber: number },
) {
  const url = new URL(s3Url(env, input.objectKey));
  url.searchParams.set("partNumber", String(input.partNumber));
  url.searchParams.set("uploadId", input.uploadId);
  url.searchParams.set("X-Amz-Expires", "900");
  const request = await signer(env).sign(url.toString(), {
    method: "PUT",
    aws: { signQuery: true },
  });
  return { uploadUrl: request.url, expiresIn: 900 };
}

export async function completeMultipart(
  env: Env,
  input: { objectKey: string; uploadId: string; parts: R2UploadedPart[] },
) {
  const upload = env.MEDIA_BUCKET.resumeMultipartUpload(
    input.objectKey,
    input.uploadId,
  );
  return upload.complete(input.parts);
}

export async function signedDeliveryUrl(
  env: Env,
  objectKey: string,
  expiresIn = 3_600,
): Promise<string> {
  const ttl = Math.max(60, Math.min(Math.floor(expiresIn), 3_600));
  const expires = Math.floor(Date.now() / 1_000) + ttl;
  const encodedObjectKey = base64UrlEncode(encoder.encode(objectKey));
  const base = env.R2_PUBLIC_DELIVERY_HOST.endsWith("/")
    ? env.R2_PUBLIC_DELIVERY_HOST
    : `${env.R2_PUBLIC_DELIVERY_HOST}/`;
  const url = new URL(`delivery/${encodedObjectKey}`, base);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set(
    "signature",
    await deliverySignature(env, encodedObjectKey, expires),
  );
  return url.toString();
}

export async function verifyDeliveryRequest(
  env: Env,
  encodedObjectKey: string,
  expiresValue: string | undefined,
  suppliedSignature: string | undefined,
): Promise<string | null> {
  if (!expiresValue || !suppliedSignature || !/^\d{10}$/.test(expiresValue))
    return null;
  const expires = Number(expiresValue);
  const now = Math.floor(Date.now() / 1_000);
  if (expires < now || expires > now + 3_600) return null;
  try {
    const expected = base64UrlDecode(
      await deliverySignature(env, encodedObjectKey, expires),
    );
    const supplied = base64UrlDecode(suppliedSignature);
    if (!constantTimeEqual(expected, supplied)) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      base64UrlDecode(encodedObjectKey),
    );
  } catch {
    return null;
  }
}
