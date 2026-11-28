import { describe, expect, it } from "vitest";
import { computeLineDiff } from "./diff";

describe("computeLineDiff", () => {
  it("returns an empty array for two empty strings", () => {
    expect(computeLineDiff("", "")).toEqual([]);
  });

  it("marks all lines as context when old and new text are identical", () => {
    expect(computeLineDiff("# Title\n\nBody\n", "# Title\n\nBody\n")).toEqual([
      { type: "context", value: "# Title" },
      { type: "context", value: "" },
      { type: "context", value: "Body" },
    ]);
  });

  it("classifies context, removed, and added lines for multi-line edits", () => {
    const oldText = "# Notes\nLine 1\nOld line\nFooter\n";
    const newText = "# Notes\nLine 1\nNew line A\nNew line B\nFooter\n";

    expect(computeLineDiff(oldText, newText)).toEqual([
      { type: "context", value: "# Notes" },
      { type: "context", value: "Line 1" },
      { type: "removed", value: "Old line" },
      { type: "added", value: "New line A" },
      { type: "added", value: "New line B" },
      { type: "context", value: "Footer" },
    ]);
  });

  it("handles pure additions, pure deletions, and blank lines without phantom entries", () => {
    expect(computeLineDiff("", "first\nsecond\n")).toEqual([
      { type: "added", value: "first" },
      { type: "added", value: "second" },
    ]);

    expect(computeLineDiff("only\n", "")).toEqual([{ type: "removed", value: "only" }]);

    expect(computeLineDiff("\n", "\n\n")).toEqual([
      { type: "context", value: "" },
      { type: "added", value: "" },
    ]);
  });

  it("strips CRLF line endings cleanly from diff line values", () => {
    expect(computeLineDiff("a\r\nb\r\n", "a\r\nc\r\n")).toEqual([
      { type: "context", value: "a" },
      { type: "removed", value: "b" },
      { type: "added", value: "c" },
    ]);
  });
});
