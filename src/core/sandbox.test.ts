import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceError } from "./error";
import { isMarkdownPath, normalizeRelative } from "./sandbox";

function expectErrorCode(fn: () => unknown, code: WorkspaceError["code"]): void {
  try {
    fn();
    expect.fail(`Expected WorkspaceError(${code})`);
  } catch (err) {
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).code).toBe(code);
  }
}

describe("sandbox path utilities", () => {
  it("normalizes clean and internal relative paths", () => {
    expect(normalizeRelative("")).toBe("");
    expect(normalizeRelative(".")).toBe("");
    expect(normalizeRelative("./notes.md")).toBe("notes.md");
    expect(normalizeRelative("a/b/../notes.md")).toBe(path.join("a", "notes.md"));
  });

  it("rejects traversal escapes and absolute paths", () => {
    expectErrorCode(() => normalizeRelative("../secret.md"), "PathOutsideRoot");
    expectErrorCode(() => normalizeRelative("a/../../secret.md"), "PathOutsideRoot");
    expectErrorCode(() => normalizeRelative(".."), "PathOutsideRoot");
    expectErrorCode(() => normalizeRelative("/etc/passwd"), "PathOutsideRoot");
  });

  it("matches .md extensions case-insensitively", () => {
    expect(isMarkdownPath("notes.md")).toBe(true);
    expect(isMarkdownPath("dir/NOTES.MD")).toBe(true);
    expect(isMarkdownPath("ReadMe.Md")).toBe(true);
    expect(isMarkdownPath("notes.txt")).toBe(false);
    expect(isMarkdownPath("notes.markdown")).toBe(false);
    expect(isMarkdownPath("README")).toBe(false);
    expect(isMarkdownPath(".md")).toBe(false);
  });
});
