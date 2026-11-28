import { describe, expect, it } from "vitest";
import { hasContentChanged, hashContent } from "./index";

describe("hash utilities", () => {
  it("computes standard lowercase SHA-256 hex digests for UTF-8 strings", () => {
    // Known SHA-256 test vectors
    expect(hashContent("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hashContent("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(hashContent("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches exact UTF-8 byte digests between strings and Uint8Array", () => {
    const text = "# Saphren — notes ✨\nLine 2\n";
    const bytes = new TextEncoder().encode(text);
    expect(hashContent(text)).toBe(hashContent(bytes));
  });

  it("hashes line endings verbatim without normalizing CRLF and LF", () => {
    const lf = "line 1\nline 2\n";
    const crlf = "line 1\r\nline 2\r\n";
    expect(hashContent(lf)).not.toBe(hashContent(crlf));
    expect(hasContentChanged(hashContent(lf), crlf)).toBe(true);
  });

  it("detects changes via hasContentChanged", () => {
    const initial = "# Draft\n";
    const initialHash = hashContent(initial);

    expect(hasContentChanged(initialHash, initial)).toBe(false);
    expect(hasContentChanged(initialHash, "# Draft!\n")).toBe(true);
    expect(hasContentChanged(initialHash, Buffer.from(initial, "utf8"))).toBe(false);
  });
});
