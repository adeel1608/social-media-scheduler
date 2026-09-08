import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { deleteUploadThingFile } from "../src/storage";
import { handleUploadThingRequest } from "../src/uploadthing";

const canaries = {
  apiKey: `sk_live_API_KEY_CANARY_${"x".repeat(40)}`,
  providerKey: "PROVIDER_FILE_KEY_CANARY_4c88d7",
  filename: "FILENAME_CANARY_private-launch.mp4",
  url: "https://media-canary.invalid/private/path",
  query: "QUERY_CANARY=pre-publication",
  requestHeader: "REQUEST_HEADER_CANARY_secret-context",
  requestBody: "REQUEST_BODY_CANARY_private-caption",
  responseBody: "RESPONSE_BODY_CANARY_provider-detail",
  tracing: "TRACE_HEADER_CANARY_00-private",
  errorMessage: "ERROR_MESSAGE_CANARY_provider-failure",
  cause: "NESTED_CAUSE_CANARY_socket-context",
  annotations: "SDK_ANNOTATIONS_CANARY_request-response",
} as const;

function token(): string {
  return btoa(
    JSON.stringify({
      apiKey: canaries.apiKey,
      appId: "postline123",
      regions: ["syd1"],
    }),
  );
}

function environment(): Env {
  return {
    ENVIRONMENT: "production",
    WORKER_PUBLIC_URL: "https://worker.example.test",
    UPLOADTHING_TOKEN: token(),
  } as Env;
}

type CapturedConsole = Array<[string, ...unknown[]]>;

function captureConsole(): CapturedConsole {
  const captured: CapturedConsole = [];
  for (const level of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      captured.push([level, ...args]);
    });
  }
  return captured;
}

function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item instanceof Error
      ? {
          name: item.name,
          message: item.message,
          cause: item.cause,
        }
      : item,
  );
}

function expectNoCanaries(value: unknown): void {
  const output = serialized(value);
  for (const canary of Object.values(canaries)) {
    expect(output).not.toContain(canary);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("UploadThing production logging boundary", () => {
  it("sanitizes the actual configured upload route failure", async () => {
    const captured = captureConsole();
    const response = await handleUploadThingRequest(
      environment(),
      new Request(
        `${canaries.url}/api/uploadthing?slug=media&${canaries.query}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "uploadthing-hook": "callback",
            "x-uploadthing-version": "7.7.4",
            "x-uploadthing-signature": canaries.requestHeader,
            traceparent: canaries.tracing,
          },
          body: JSON.stringify({
            file: {
              key: canaries.providerKey,
              name: canaries.filename,
              url: `${canaries.url}?${canaries.query}`,
            },
            caption: canaries.requestBody,
            error: {
              message: canaries.errorMessage,
              cause: canaries.cause,
              annotations: canaries.annotations,
            },
          }),
        },
      ),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      code: "UPLOAD_FAILED",
      message: "Upload could not be completed.",
    });
    expect(captured).toEqual([
      [
        "error",
        '{"level":"error","message":"uploadthing_route_failed","state":"upload_route","classification":"request_rejected"}',
      ],
    ]);
    expectNoCanaries(captured);
    expectNoCanaries(body);
  });

  it("suppresses request, response and nested errors from actual SDK deletion failures", async () => {
    const captured = captureConsole();
    const providerFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: canaries.errorMessage,
            body: canaries.responseBody,
            filename: canaries.filename,
            url: `${canaries.url}?${canaries.query}`,
            requestHeader: canaries.requestHeader,
            requestBody: canaries.requestBody,
            cause: canaries.cause,
            annotations: canaries.annotations,
          }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              traceparent: canaries.tracing,
            },
          },
        ),
    );
    vi.stubGlobal("fetch", providerFetch);

    let responseFailure: unknown;
    try {
      await deleteUploadThingFile(environment(), canaries.providerKey);
    } catch (error) {
      responseFailure = error;
    }
    expect(responseFailure).toMatchObject({
      code: "provider_delete_failed",
      status: 502,
      message: "UploadThing did not confirm media deletion.",
    });

    const nested = new Error(canaries.errorMessage, {
      cause: new Error(canaries.cause),
    }) as Error & { annotations: Record<string, unknown> };
    nested.annotations = {
      marker: canaries.annotations,
      request: {
        url: `${canaries.url}?${canaries.query}`,
        headers: canaries.requestHeader,
        body: canaries.requestBody,
        providerFileKey: canaries.providerKey,
      },
      response: {
        body: canaries.responseBody,
        tracing: canaries.tracing,
      },
    };
    providerFetch.mockRejectedValue(nested);

    let networkFailure: unknown;
    try {
      await deleteUploadThingFile(environment(), canaries.providerKey);
    } catch (error) {
      networkFailure = error;
    }
    expect(networkFailure).toMatchObject({
      code: "provider_delete_failed",
      status: 502,
      message: "UploadThing did not confirm media deletion.",
    });
    expect(captured).toEqual([
      [
        "error",
        '{"level":"error","message":"uploadthing_delete_failed","state":"delete_file","classification":"provider_failure"}',
      ],
      [
        "error",
        '{"level":"error","message":"uploadthing_delete_failed","state":"delete_file","classification":"provider_failure"}',
      ],
    ]);
    expectNoCanaries(captured);
    expectNoCanaries(responseFailure);
    expectNoCanaries(networkFailure);
  });

  it("keeps successful actual SDK deletion silent and confirmed", async () => {
    const captured = captureConsole();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true, deletedCount: 1 })),
    );

    await expect(
      deleteUploadThingFile(environment(), "successful-provider-key"),
    ).resolves.toEqual({ confirmed: true, alreadyAbsent: false });
    expect(captured).toEqual([]);
  });
});
