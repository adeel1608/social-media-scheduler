import { describe, expect, it, vi } from "vitest";

import { inspectPublicDeployment } from "../../../scripts/inspect-public-deployment.mjs";

describe("read-only public deployment inspection", () => {
  it("checks every public route and an expected unavailable bootstrap", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      Promise.resolve(
        new Response(null, {
          status: String(input).includes("workers.dev") ? 503 : 200,
        }),
      ),
    );

    await expect(
      inspectPublicDeployment(
        {
          appUrl: "https://postline-owner.pages.dev",
          workerUrl: "https://postline-owner.workers.dev",
          expectedWorkerStatus: 503,
        },
        { fetcher },
      ),
    ).resolves.toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("fails on redirects, unexpected status, or unsafe input URLs", async () => {
    await expect(
      inspectPublicDeployment(
        {
          appUrl: "https://postline-owner.pages.dev/path",
          workerUrl: "https://postline-owner.workers.dev",
          expectedWorkerStatus: 503,
        },
        { fetcher: vi.fn<typeof fetch>() },
      ),
    ).rejects.toThrow(/credential-free HTTPS origin/);

    await expect(
      inspectPublicDeployment(
        {
          appUrl: "https://postline-owner.pages.dev",
          workerUrl: "https://postline-owner.workers.dev",
          expectedWorkerStatus: 503,
        },
        {
          fetcher: vi.fn<typeof fetch>(async () =>
            Promise.resolve(new Response(null, { status: 302 })),
          ),
        },
      ),
    ).rejects.toThrow(/returned HTTP 302/);
  });
});
