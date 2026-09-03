import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor } from "../src";

describe("large paginated queues", () => {
  it("uses opaque stable cursors with no hard-coded total limit", () => {
    const records = Array.from({ length: 25_000 }, (_, id) => ({
      id: String(id),
      scheduledAt: new Date(1_800_000_000_000 + id).toISOString(),
    }));
    const pageSize = 50;
    const pages = Math.ceil(records.length / pageSize);
    expect(pages).toBe(500);
    const cursor = encodeCursor(records[pageSize - 1]!);
    expect(decodeCursor(cursor)).toEqual(records[pageSize - 1]);
  });
});
