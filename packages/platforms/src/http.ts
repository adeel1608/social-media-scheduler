import { redactSecrets, type Platform } from "@scheduler/shared";

import type { Fetch, PlatformError } from "./types";

export type ProviderOperation = "read" | "idempotent" | "publish";

export interface ProviderRequestInit extends RequestInit {
  operation: ProviderOperation;
}

export function trustedUploadSessionUrl(
  platform: Platform,
  value: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Provider upload session URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new Error("Provider upload session URL is invalid");
  }
  const trusted =
    platform === "youtube"
      ? url.hostname === "www.googleapis.com" &&
        url.pathname === "/upload/youtube/v3/videos" &&
        url.searchParams.get("uploadType") === "resumable" &&
        Boolean(url.searchParams.get("upload_id"))
      : platform === "tiktok"
        ? url.hostname === "open-upload.tiktokapis.com" &&
          /^\/(?:upload|video)\/$/.test(url.pathname)
        : false;
  if (!trusted) throw new Error("Provider upload session URL is not trusted");
  return url.href;
}

export async function jsonRequest<T>(
  fetcher: Fetch,
  url: string,
  init: ProviderRequestInit,
  timeoutMs = 15_000,
): Promise<T> {
  const response = await providerRequest(fetcher, url, init, timeoutMs);
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw providerNetworkError(init.operation);
  }
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 500) };
    }
  }
  if (!response.ok)
    throw providerHttpError(response.status, body, init.operation);
  return body as T;
}

export async function providerRequest(
  fetcher: Fetch,
  url: string,
  init: ProviderRequestInit,
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const forwardAbort = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) forwardAbort();
  else upstreamSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const { operation: _operation, ...requestInit } = init;
  try {
    return await fetcher(url, {
      ...requestInit,
      signal: controller.signal,
    });
  } catch {
    throw providerNetworkError(init.operation);
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", forwardAbort);
  }
}

export function providerHttpError(
  status: number,
  body: unknown,
  operation: ProviderOperation,
) {
  const ambiguous = operation === "publish" && status >= 500;
  return {
    name: "PlatformHttpError",
    status,
    body: redactSecrets(body),
    message: `Platform request failed with HTTP ${status}`,
    retryable: !ambiguous && (status === 429 || status >= 500),
    ambiguous,
  };
}

function providerNetworkError(operation: ProviderOperation) {
  const ambiguous = operation === "publish";
  return {
    name: "NetworkError",
    code: "network_error",
    message: "Network request failed",
    retryable: !ambiguous,
    ambiguous,
  };
}

export function genericNormalizeError(error: unknown): PlatformError {
  if (error && typeof error === "object") {
    const candidate = error as Record<string, any>;
    const body = candidate.body as Record<string, any> | undefined;
    const nested = body?.error ?? body;
    const status =
      typeof candidate.status === "number" ? candidate.status : undefined;
    const candidateCode = String(
      nested?.code ?? nested?.error_code ?? candidate.code ?? "platform_error",
    );
    const code = /^[a-zA-Z0-9._:-]{1,100}$/.test(candidateCode)
      ? candidateCode
      : "platform_error";
    const message = sanitizePlatformErrorText(
      nested?.message ??
        nested?.error_description ??
        candidate.message ??
        "Platform request failed",
    );
    const ambiguous = Boolean(candidate.ambiguous);
    const explicitlyRetryable =
      typeof candidate.retryable === "boolean"
        ? candidate.retryable
        : undefined;
    return {
      code,
      message,
      retryable:
        explicitlyRetryable ??
        (!ambiguous &&
          (status === 429 || (status !== undefined && status >= 500))),
      ambiguous,
      ...(status !== undefined ? { httpStatus: status } : {}),
    };
  }
  return {
    code: "unknown_error",
    message: "An unknown platform error occurred",
    retryable: false,
    ambiguous: false,
  };
}

function sanitizePlatformErrorText(value: unknown): string {
  const redacted = String(redactSecrets(String(value))).replace(
    /https?:\/\/\S+/gi,
    "[REDACTED_URL]",
  );
  return redacted.slice(0, 500);
}
