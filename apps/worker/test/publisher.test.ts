import { describe, expect, it } from "vitest";

import { acceptedUploadByte } from "../src/publisher";

describe("resumable upload progress", () => {
  it("uses YouTube's acknowledged range instead of assuming the chunk", () => {
    const response = new Response(null, {
      status: 308,
      headers: { Range: "bytes=0-524287" },
    });

    expect(acceptedUploadByte("youtube", response, 1_048_576)).toBe(524_288);
  });

  it("restarts at zero when YouTube acknowledges no bytes", () => {
    expect(
      acceptedUploadByte(
        "youtube",
        new Response(null, { status: 308 }),
        1_048_576,
      ),
    ).toBe(0);
  });

  it("rejects impossible YouTube ranges and trusts successful TikTok chunks", () => {
    expect(() =>
      acceptedUploadByte(
        "youtube",
        new Response(null, {
          status: 308,
          headers: { Range: "bytes=0-2097151" },
        }),
        1_048_576,
      ),
    ).toThrow("invalid resumable upload range");
    expect(
      acceptedUploadByte(
        "tiktok",
        new Response(null, { status: 206 }),
        1_048_576,
      ),
    ).toBe(1_048_576);
  });
});
