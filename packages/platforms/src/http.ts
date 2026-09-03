import { redactSecrets } from "@scheduler/shared";

import type { Fetch, PlatformError } from "./types";

export async function jsonRequest<T>(
  fetcher: Fetch,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (error) {
    throw {
      name: "NetworkError",
      code: "network_error",
      message:
        error instanceof Error ? error.message : "Network request failed",
      ambiguous: init.method !== "GET",
    };
  }
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    throw {
      name: "PlatformHttpError",
      status: response.status,
      body: redactSecrets(body),
      message: `Platform request failed with HTTP ${response.status}`,
    };
  }
  return body as T;
}

export function genericNormalizeError(error: unknown): PlatformError {
  if (error && typeof error === "object") {
    const candidate = error as Record<string, any>;
    const body = candidate.body as Record<string, any> | undefined;
    const nested = body?.error ?? body;
    const status =
      typeof candidate.status === "number" ? candidate.status : undefined;
    const code = String(
      nested?.code ?? nested?.error_code ?? candidate.code ?? "platform_error",
    );
    const message = String(
      nested?.message ??
        nested?.error_description ??
        candidate.message ??
        "Platform request failed",
    );
    const ambiguous = Boolean(
      candidate.ambiguous ?? candidate.name === "NetworkError",
    );
    return {
      code,
      message: message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]"),
      retryable:
        !ambiguous &&
        (status === 429 || (status !== undefined && status >= 500)),
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
