// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  cancelPendingOAuth,
  completeOAuthNavigation,
  startOAuthNavigation,
  uploadDirect,
  type UploadThingClient,
} from "./api";

const session = {
  access_token: "owner-jwt",
} as Parameters<typeof uploadDirect>[1];

describe("browser UploadThing integration", () => {
  it("sends the owner JWT, reports progress, and resolves only with server-confirmed media", async () => {
    const progress: number[] = [];
    const uploader: UploadThingClient = {
      async uploadFiles(endpoint, options) {
        expect(endpoint).toBe("media");
        expect(new Headers(options.headers).get("Authorization")).toBe(
          "Bearer owner-jwt",
        );
        expect(options.input).toMatchObject({
          filename: "clip.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 4,
        });
        options.onUploadProgress({ progress: 47 });
        options.onUploadProgress({ progress: 100 });
        return [
          {
            key: "provider-key",
            serverData: {
              mediaId: "123e4567-e89b-42d3-a456-426614174000",
              objectKey: "provider-key",
              uploadStatus: "complete",
            },
          },
        ];
      },
    };

    const result = await uploadDirect(
      new File([new Uint8Array(4)], "clip.bin", {
        type: "application/octet-stream",
      }),
      session,
      (value) => progress.push(value),
      uploader,
    );

    expect(progress).toEqual([47, 100]);
    expect(result.mediaId).toBe("123e4567-e89b-42d3-a456-426614174000");
  });

  it("does not expose media for selection when callback confirmation is absent", async () => {
    const uploader: UploadThingClient = {
      uploadFiles: vi
        .fn()
        .mockResolvedValue([{ key: "provider-key", serverData: null }]),
    };

    await expect(
      uploadDirect(
        new File([new Uint8Array(4)], "clip.bin", {
          type: "application/octet-stream",
        }),
        session,
        vi.fn(),
        uploader,
      ),
    ).rejects.toThrow("server did not confirm it for scheduling");
  });
});

describe("browser OAuth navigation", () => {
  it.each([
    ["start", startOAuthNavigation],
    ["complete", completeOAuthNavigation],
  ])(
    "submits %s with a transient body token and no URL secret",
    (_name, navigate) => {
      const submit = vi
        .spyOn(HTMLFormElement.prototype, "submit")
        .mockImplementation(() => undefined);
      navigate("instagram", session);

      expect(submit).toHaveBeenCalledTimes(1);
      const form = submit.mock.instances[0] as HTMLFormElement;
      expect(form.method).toBe("post");
      expect(form.action).toMatch(/\/api\/oauth\/instagram\/(start|complete)$/);
      expect(form.action).not.toContain(session.access_token);
      expect(
        form.querySelector<HTMLInputElement>("[name=session_token]")?.value,
      ).toBe(session.access_token);
      expect(document.body.contains(form)).toBe(false);
      submit.mockRestore();
    },
  );

  it("attempts bounded credentialed server cancellation during sign-out", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    await cancelPendingOAuth(session, fetcher, 100);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/oauth\/cancel$/),
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${session.access_token}` },
      }),
    );
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain(
      session.access_token,
    );
  });
});
