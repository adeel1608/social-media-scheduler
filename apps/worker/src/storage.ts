import { UTApi } from "uploadthing/server";

import type { Env } from "./env";

export const ACTIVE_MEDIA_LIMIT_BYTES = Math.floor(1.8 * 1024 ** 3);
export const UPLOAD_RESERVATION_SECONDS = 24 * 60 * 60;

export interface StoredMedia {
  id: string;
  owner_id: string;
  storage_provider: string;
  provider_file_key: string | null;
  provider_url: string | null;
  object_key: string;
  mime_type: string;
  size_bytes: number;
  upload_status: string;
  deleted_at: string | null;
}

export interface UploadThingDeletionClient {
  deleteFiles(
    keys: string | string[],
    options?: { keyType?: "fileKey" | "customId" },
  ): Promise<{ success: boolean; deletedCount: number }>;
}

export interface DeliveryReference {
  mediaId: string;
  ownerId: string;
}

export class MediaStorageError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MediaStorageError";
  }
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

export function uploadThingAppId(token: string): string {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      base64UrlDecode(token),
    );
    const payload = JSON.parse(decoded) as {
      appId?: unknown;
      apiKey?: unknown;
      regions?: unknown;
    };
    if (
      typeof payload.appId !== "string" ||
      !/^[a-zA-Z0-9_-]{3,128}$/.test(payload.appId) ||
      typeof payload.apiKey !== "string" ||
      !Array.isArray(payload.regions)
    ) {
      throw new Error("Unexpected token payload");
    }
    return payload.appId;
  } catch {
    throw new MediaStorageError(
      "invalid_uploadthing_token",
      500,
      "UploadThing server configuration is invalid.",
    );
  }
}

export function canonicalUploadThingUrl(env: Env, fileKey: string): string {
  const appId = uploadThingAppId(env.UPLOADTHING_TOKEN);
  return `https://${appId}.ufs.sh/f/${encodeURIComponent(fileKey)}`;
}

export function validateUploadThingUrl(
  env: Env,
  value: string,
  expectedIdentifiers: string[],
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unsafeProviderUrl();
  }
  const appId = uploadThingAppId(env.UPLOADTHING_TOKEN).toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const allowedHost = hostname === `${appId}.ufs.sh` || hostname === "utfs.io";
  if (
    url.protocol !== "https:" ||
    !allowedHost ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw unsafeProviderUrl();
  }
  const match = /^\/f\/([^/]+)$/.exec(url.pathname);
  if (!match) throw unsafeProviderUrl();
  let identifier: string;
  try {
    identifier = decodeURIComponent(match[1]!);
  } catch {
    throw unsafeProviderUrl();
  }
  if (
    identifier.includes("/") ||
    !expectedIdentifiers.some((expected) => expected === identifier)
  ) {
    throw unsafeProviderUrl();
  }
  return url;
}

function unsafeProviderUrl() {
  return new MediaStorageError(
    "unsafe_uploadthing_url",
    502,
    "UploadThing returned an unexpected media URL.",
  );
}

function assertAvailable(media: StoredMedia): asserts media is StoredMedia & {
  provider_file_key: string;
  provider_url: string;
} {
  if (
    media.storage_provider !== "uploadthing" ||
    media.upload_status !== "complete" ||
    media.deleted_at ||
    !media.provider_file_key ||
    !media.provider_url
  ) {
    throw new MediaStorageError(
      "media_not_available",
      404,
      "Source media is not available.",
    );
  }
}

async function fetchUploadThing(
  env: Env,
  media: StoredMedia,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<Response> {
  assertAvailable(media);
  const url = validateUploadThingUrl(env, media.provider_url, [
    media.provider_file_key,
    media.id,
  ]);
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: "manual" });
  } catch {
    throw new MediaStorageError(
      "provider_fetch_failed",
      502,
      "Stored media could not be reached.",
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new MediaStorageError(
      "provider_redirect_rejected",
      502,
      "Unexpected storage redirect was rejected.",
    );
  }
  return response;
}

export async function fetchMediaBody(
  env: Env,
  media: StoredMedia,
  fetcher: typeof fetch = fetch,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetchUploadThing(
    env,
    media,
    { method: "GET" },
    fetcher,
  );
  if (response.status !== 200 || !response.body) {
    throw new MediaStorageError(
      "provider_body_unavailable",
      502,
      "Stored media returned an unexpected response.",
    );
  }
  return response.body;
}

export async function fetchMediaRange(
  env: Env,
  media: StoredMedia,
  start: number,
  endExclusive: number,
  fetcher: typeof fetch = fetch,
): Promise<ReadableStream<Uint8Array>> {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endExclusive) ||
    start < 0 ||
    endExclusive <= start ||
    endExclusive > media.size_bytes
  ) {
    throw new MediaStorageError(
      "invalid_source_range",
      416,
      "Requested source range is invalid.",
    );
  }
  const response = await fetchUploadThing(
    env,
    media,
    {
      method: "GET",
      headers: { Range: `bytes=${start}-${endExclusive - 1}` },
    },
    fetcher,
  );
  const parsed = parseUpstreamContentRange(
    response.headers.get("Content-Range"),
  );
  if (
    response.status !== 206 ||
    !response.body ||
    !parsed ||
    parsed.start !== start ||
    parsed.end !== endExclusive - 1 ||
    parsed.total !== media.size_bytes
  ) {
    throw new MediaStorageError(
      "invalid_provider_range",
      502,
      "Stored media returned an invalid byte range.",
    );
  }
  const contentLength = response.headers.get("Content-Length");
  if (contentLength && Number(contentLength) !== endExclusive - start) {
    throw new MediaStorageError(
      "invalid_provider_length",
      502,
      "Stored media returned an invalid content length.",
    );
  }
  return response.body;
}

function parseUpstreamContentRange(value: string | null) {
  if (!value) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    ![start, end, total].every(Number.isSafeInteger) ||
    start < 0 ||
    end < start ||
    total <= end
  )
    return null;
  return { start, end, total };
}

export function parseSingleRange(
  value: string,
  totalBytes: number,
): { start: number; end: number; length: number } | null {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    value.includes(",")
  )
    return null;
  let start: number;
  let end: number;
  let match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (match) {
    start = Number(match[1]);
    end = match[2]
      ? Math.min(Number(match[2]), totalBytes - 1)
      : totalBytes - 1;
  } else {
    match = /^bytes=-(\d+)$/.exec(value);
    if (!match) return null;
    const suffixLength = Number(match[1]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, totalBytes - suffixLength);
    end = totalBytes - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= totalBytes ||
    end < start
  )
    return null;
  return { start, end, length: end - start + 1 };
}

export async function deliveryResponse(
  env: Env,
  media: StoredMedia,
  method: "GET" | "HEAD",
  rangeHeader?: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  assertAvailable(media);
  const range =
    method === "GET" && rangeHeader
      ? parseSingleRange(rangeHeader, media.size_bytes)
      : undefined;
  if (method === "GET" && rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${media.size_bytes}` },
    });
  }
  const upstream = range
    ? await fetchUploadThing(
        env,
        media,
        {
          method: "GET",
          headers: { Range: `bytes=${range.start}-${range.end}` },
        },
        fetcher,
      )
    : await fetchUploadThing(env, media, { method }, fetcher);
  if (range) {
    const parsed = parseUpstreamContentRange(
      upstream.headers.get("Content-Range"),
    );
    if (
      upstream.status !== 206 ||
      !upstream.body ||
      !parsed ||
      parsed.start !== range.start ||
      parsed.end !== range.end ||
      parsed.total !== media.size_bytes
    ) {
      throw new MediaStorageError(
        "invalid_provider_range",
        502,
        "Stored media returned an invalid byte range.",
      );
    }
  } else if (upstream.status !== 200 || (method === "GET" && !upstream.body)) {
    throw new MediaStorageError(
      "provider_body_unavailable",
      502,
      "Stored media returned an unexpected response.",
    );
  }
  const length = range?.length ?? media.size_bytes;
  const upstreamLength = upstream.headers.get("Content-Length");
  if (upstreamLength && Number(upstreamLength) !== length) {
    throw new MediaStorageError(
      "invalid_provider_length",
      502,
      "Stored media returned an invalid content length.",
    );
  }
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Length": String(length),
    "Content-Type": media.mime_type,
    "X-Content-Type-Options": "nosniff",
  });
  if (range)
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${media.size_bytes}`,
    );
  return new Response(method === "HEAD" ? null : upstream.body, {
    status: range ? 206 : 200,
    headers,
  });
}

async function deliverySignature(
  env: Env,
  encodedMediaId: string,
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
    toArrayBuffer(encoder.encode(`${encodedMediaId}\n${expires}`)),
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

export async function signedDeliveryUrl(
  env: Env,
  reference: DeliveryReference,
  expiresIn = 3_600,
): Promise<string> {
  const ttl = Math.max(60, Math.min(Math.floor(expiresIn), 3_600));
  const expires = Math.floor(Date.now() / 1_000) + ttl;
  const encodedMediaId = base64UrlEncode(
    encoder.encode(`${reference.ownerId}:${reference.mediaId}`),
  );
  const base = env.WORKER_PUBLIC_URL.endsWith("/")
    ? env.WORKER_PUBLIC_URL
    : `${env.WORKER_PUBLIC_URL}/`;
  const url = new URL(`delivery/${encodedMediaId}`, base);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set(
    "signature",
    await deliverySignature(env, encodedMediaId, expires),
  );
  return url.toString();
}

export async function verifyDeliveryRequest(
  env: Env,
  encodedMediaId: string,
  expiresValue: string | undefined,
  suppliedSignature: string | undefined,
): Promise<DeliveryReference | null> {
  if (!expiresValue || !suppliedSignature || !/^\d{10}$/.test(expiresValue))
    return null;
  const expires = Number(expiresValue);
  const now = Math.floor(Date.now() / 1_000);
  if (expires < now || expires > now + 3_600) return null;
  try {
    const expected = base64UrlDecode(
      await deliverySignature(env, encodedMediaId, expires),
    );
    const supplied = base64UrlDecode(suppliedSignature);
    if (!constantTimeEqual(expected, supplied)) return null;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      base64UrlDecode(encodedMediaId),
    );
    const [ownerId, mediaId, extra] = decoded.split(":");
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return !extra &&
      ownerId &&
      mediaId &&
      uuid.test(ownerId) &&
      uuid.test(mediaId)
      ? { ownerId, mediaId }
      : null;
  } catch {
    return null;
  }
}

export function uploadThingDeletionClient(
  env: Env,
  fetcher: typeof fetch = fetch,
): UploadThingDeletionClient {
  return new UTApi({
    token: env.UPLOADTHING_TOKEN,
    fetch: fetcher,
    logLevel: "Error",
  });
}

export async function deleteUploadThingFile(
  env: Env,
  identifier: string,
  keyType: "fileKey" | "customId" = "fileKey",
  client: UploadThingDeletionClient = uploadThingDeletionClient(env),
) {
  const result = await client.deleteFiles(identifier, { keyType });
  if (!result.success) {
    throw new MediaStorageError(
      "provider_delete_failed",
      502,
      "UploadThing did not confirm media deletion.",
    );
  }
  return {
    confirmed: true as const,
    alreadyAbsent: result.deletedCount === 0,
  };
}

export function reservationDeletionTarget(reservation: {
  id: string;
  provider_file_key: string | null;
}) {
  return reservation.provider_file_key
    ? {
        identifier: reservation.provider_file_key,
        keyType: "fileKey" as const,
      }
    : { identifier: reservation.id, keyType: "customId" as const };
}
