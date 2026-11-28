import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_VERSION, Workspace, WorkspaceError } from "./index";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saphren-core-test-"));
  tempDirs.push(dir);
  return dir;
}

function expectErrorCode(fn: () => unknown, code: WorkspaceError["code"]): void {
  try {
    fn();
    expect.fail(`Expected WorkspaceError(${code})`);
  } catch (err) {
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).code).toBe(code);
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Workspace", () => {
  it("exposes a non-empty core version", () => {
    expect(CORE_VERSION.length).toBeGreaterThan(0);
  });

  it("canonicalizes the workspace root on open", () => {
    const dir = makeTempDir();
    const ws = Workspace.open(dir);
    expect(ws.root).toBe(fs.realpathSync(dir));
  });

  it("rejects missing and file roots", () => {
    const dir = makeTempDir();

    const missing = path.join(dir, "does-not-exist");
    expectErrorCode(() => Workspace.open(missing), "InvalidWorkspaceRoot");

    const file = path.join(dir, "notes.md");
    fs.writeFileSync(file, "# hi");
    expectErrorCode(() => Workspace.open(file), "InvalidWorkspaceRoot");
  });

  it("blocks path traversal escapes", () => {
    const parent = makeTempDir();
    const root = path.join(parent, "workspace");
    fs.mkdirSync(path.join(root, "nested"), { recursive: true });
    fs.writeFileSync(path.join(parent, "outside.md"), "secret");

    const ws = Workspace.open(root);

    for (const escape of [
      "../outside.md",
      "../nonexistent.md",
      "nested/../../outside.md",
      "nested/../../nonexistent.md",
    ]) {
      expectErrorCode(() => ws.readFile(escape), "PathOutsideRoot");
      expectErrorCode(() => ws.saveFile(escape, "pwned"), "PathOutsideRoot");
    }

    expectErrorCode(() => ws.listFiles(".."), "PathOutsideRoot");
    expectErrorCode(() => ws.listFiles("nested/../.."), "PathOutsideRoot");
    expect(fs.readFileSync(path.join(parent, "outside.md"), "utf8")).toBe("secret");
    expect(fs.existsSync(path.join(parent, "nonexistent.md"))).toBe(false);
  });

  it("blocks absolute paths", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "notes.md"), "hello");

    const ws = Workspace.open(dir);
    const insideAbs = path.join(ws.root, "notes.md");

    expectErrorCode(() => ws.readFile(insideAbs), "PathOutsideRoot");
    expectErrorCode(() => ws.saveFile(insideAbs, "overwrite"), "PathOutsideRoot");
    expectErrorCode(() => ws.listFiles(ws.root), "PathOutsideRoot");

    const outsideAbs = path.join(os.tmpdir(), "saphren-outside.md");
    expectErrorCode(() => ws.readFile(outsideAbs), "PathOutsideRoot");
  });

  it.skipIf(process.platform === "win32")(
    "blocks and omits symlinks pointing to outside files",
    () => {
      const outside = makeTempDir();
      const secret = path.join(outside, "secret.md");
      fs.writeFileSync(secret, "top-secret-token");

      const dir = makeTempDir();
      fs.writeFileSync(path.join(dir, "safe.md"), "safe content");
      fs.symlinkSync(secret, path.join(dir, "escape.md"));

      const ws = Workspace.open(dir);

      expectErrorCode(() => ws.readFile("escape.md"), "PathOutsideRoot");
      expectErrorCode(() => ws.saveFile("escape.md", "tampered"), "PathOutsideRoot");
      expect(fs.readFileSync(secret, "utf8")).toBe("top-secret-token");

      expect(ws.listFiles()).toEqual(["safe.md"]);
      expect(ws.searchFiles("top-secret-token")).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "blocks and omits symlinks pointing to outside directories",
    () => {
      const outside = makeTempDir();
      fs.writeFileSync(path.join(outside, "secret.md"), "outside-needle");

      const dir = makeTempDir();
      fs.writeFileSync(path.join(dir, "notes.md"), "inside");
      fs.symlinkSync(outside, path.join(dir, "escape_dir"));

      const ws = Workspace.open(dir);

      expectErrorCode(() => ws.listFiles("escape_dir"), "PathOutsideRoot");
      expectErrorCode(() => ws.readFile("escape_dir/secret.md"), "PathOutsideRoot");
      expectErrorCode(() => ws.readFile("escape_dir/missing.md"), "PathOutsideRoot");
      expectErrorCode(() => ws.saveFile("escape_dir/new.md", "boom"), "PathOutsideRoot");
      expect(fs.existsSync(path.join(outside, "new.md"))).toBe(false);

      expect(ws.listFiles()).toEqual(["notes.md"]);
      expect(ws.searchFiles("outside-needle")).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "blocks dangling symlinks pointing outside root",
    () => {
      const outside = makeTempDir();
      const target = path.join(outside, "created-outside.md");

      const dir = makeTempDir();
      fs.symlinkSync(target, path.join(dir, "dangling.md"));
      fs.symlinkSync(path.join(dir, "dangling.md"), path.join(dir, "hop.md"));

      const ws = Workspace.open(dir);

      for (const rel of ["dangling.md", "hop.md"]) {
        expectErrorCode(() => ws.readFile(rel), "PathOutsideRoot");
        expectErrorCode(() => ws.saveFile(rel, "should not escape"), "PathOutsideRoot");
      }
      expect(fs.existsSync(target)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "supports internal symlinks and terminates on symlink cycles",
    () => {
      const dir = makeTempDir();
      fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
      fs.writeFileSync(path.join(dir, "sub/real.md"), "initial");
      fs.symlinkSync(path.join(dir, "sub/real.md"), path.join(dir, "alias.md"));
      fs.symlinkSync(dir, path.join(dir, "sub/loop_to_root"));

      const ws = Workspace.open(dir);

      expect(ws.readFile("alias.md")).toBe("initial");
      ws.saveFile("alias.md", "updated via alias");
      expect(ws.readFile("sub/real.md")).toBe("updated via alias");

      // Symlink cycle back to root must not infinite-loop.
      expect(ws.listFiles()).toEqual(["alias.md", "sub/real.md"]);
    },
  );

  it("lists only markdown files, skips dotfiles, and sorts deterministically", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "docs/nested"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });

    fs.writeFileSync(path.join(dir, "zeta.md"), "z");
    fs.writeFileSync(path.join(dir, "ALPHA.MD"), "a");
    fs.writeFileSync(path.join(dir, "docs/spec.md"), "spec");
    fs.writeFileSync(path.join(dir, "docs/nested/deep.md"), "deep");
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignore");
    fs.writeFileSync(path.join(dir, "README"), "ignore");
    fs.writeFileSync(path.join(dir, ".hidden.md"), "ignore");
    fs.writeFileSync(path.join(dir, ".git/commit.md"), "ignore");

    const ws = Workspace.open(dir);

    expect(ws.listFiles()).toEqual([
      "ALPHA.MD",
      "docs/nested/deep.md",
      "docs/spec.md",
      "zeta.md",
    ]);
    expect(ws.listFiles("")).toEqual(ws.listFiles());
    expect(ws.listFiles(".")).toEqual(ws.listFiles());

    expect(ws.listFiles("docs")).toEqual(["docs/nested/deep.md", "docs/spec.md"]);

    expectErrorCode(() => ws.listFiles("missing"), "NotFound");
    expectErrorCode(() => ws.listFiles("zeta.md"), "NotADirectory");
  });

  it("performs case-insensitive deterministic search and skips non-UTF-8 files", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });

    fs.writeFileSync(
      path.join(dir, "a.md"),
      "Line one\r\nTODO: write specs\r\nAnother todo item\n",
    );
    fs.writeFileSync(path.join(dir, "sub/b.md"), "No match here\nToDo at line two");
    fs.writeFileSync(path.join(dir, "ignored.txt"), "TODO in txt file");
    fs.writeFileSync(path.join(dir, "binary.md"), Buffer.from([0xff, 0xfe, 0xfd]));

    const ws = Workspace.open(dir);

    expect(ws.searchFiles("tOdO")).toEqual([
      { path: "a.md", line: 2, snippet: "TODO: write specs" },
      { path: "a.md", line: 3, snippet: "Another todo item" },
      { path: "sub/b.md", line: 2, snippet: "ToDo at line two" },
    ]);

    expect(ws.searchFiles("")).toEqual([]);
    expect(ws.searchFiles("nonexistent-term")).toEqual([]);
  });

  it("reads and atomically saves markdown files while enforcing type checks", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "folder"), { recursive: true });
    fs.writeFileSync(path.join(dir, "plain.txt"), "not markdown");

    const ws = Workspace.open(dir);

    expectErrorCode(() => ws.readFile("missing.md"), "NotFound");
    expectErrorCode(() => ws.readFile("folder"), "NotAFile");
    expectErrorCode(() => ws.saveFile("folder", "nope"), "NotAFile");
    expectErrorCode(() => ws.readFile("plain.txt"), "UnsupportedFileType");
    expectErrorCode(() => ws.saveFile("new.txt", "nope"), "UnsupportedFileType");

    ws.saveFile("deep/nested/note.md", "# Title\nBody");
    expect(ws.readFile("deep/nested/note.md")).toBe("# Title\nBody");

    ws.saveFile("deep/nested/../nested/note.md", "# Updated");
    expect(ws.readFile("deep/nested/note.md")).toBe("# Updated");

    // Ensure no temporary atomic-write files remain on disk.
    expect(fs.readdirSync(path.join(dir, "deep/nested"))).toEqual(["note.md"]);
  });
});
