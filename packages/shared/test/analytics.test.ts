import { describe, expect, it } from "vitest";

import { engagementRate, normalizeAnalytics } from "../src";

describe("analytics normalization", () => {
  it("retains raw names and computes a documented engagement rate", () => {
    const metrics = normalizeAnalytics("tiktok", {
      view_count: 100,
      like_count: 10,
      comment_count: 3,
      share_count: 2,
    });
    expect(metrics.find((item) => item.name === "views")).toMatchObject({
      value: 100,
      rawName: "view_count",
      available: true,
    });
    expect(engagementRate(metrics)).toBe(15);
  });

  it("represents missing metrics as unavailable rather than zero", () => {
    const metrics = normalizeAnalytics("youtube", { views: 20 });
    expect(metrics.find((item) => item.name === "saves")).toEqual({
      name: "saves",
      value: null,
      available: false,
    });
  });
});
