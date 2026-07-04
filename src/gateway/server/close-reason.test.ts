// Covers UTF-8-safe truncation of WebSocket close reasons.
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { truncateCloseReason } from "./close-reason.js";

describe("truncateCloseReason", () => {
  it("returns fallback text for empty reasons", () => {
    expect(truncateCloseReason("")).toBe("invalid handshake");
  });

  it("returns short reasons unchanged", () => {
    expect(truncateCloseReason("bad token")).toBe("bad token");
  });

  it("truncates long ASCII reasons to the byte cap", () => {
    const out = truncateCloseReason("x".repeat(200));
    expect(Buffer.byteLength(out)).toBe(120);
  });

  it("does not cut multi-byte UTF-8 sequences in half", () => {
    const out = truncateCloseReason("x".repeat(118) + "😀".repeat(5));
    expect(out).toBe("x".repeat(118));
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(120);
    expect(out.isWellFormed()).toBe(true);
    expect(out.includes("\uFFFD")).toBe(false);
  });

  it("keeps multi-byte characters that fit exactly at the cap", () => {
    const out = truncateCloseReason("😀".repeat(31), 120);
    expect(out).toBe("😀".repeat(30));
    expect(Buffer.byteLength(out)).toBe(120);
  });

  it("stays within caller-provided byte caps", () => {
    for (const maxBytes of [1, 2, 3, 4, 5, 122, 123]) {
      const out = truncateCloseReason("é😀".repeat(60), maxBytes);
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(maxBytes);
      expect(out.includes("\uFFFD")).toBe(false);
    }
  });
});
