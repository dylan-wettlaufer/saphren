import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashContent, Workspace, WorkspaceError, WorkspaceState } from "./index";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saphren-state-test-"));
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

describe("WorkspaceState", () => {
  it("opens a note cleanly, tracks hash-derived dirty state, and clears dirty on undo", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "notes.md"), "# Initial\n");

    const state = WorkspaceState.open(dir);
    expect(state.activeFile).toBeNull();
    expect(state.root).toBe(fs.realpathSync(dir));

    const opened = state.openFile("./notes.md");
    const initialHash = hashContent("# Initial\n");
    expect(opened).toEqual({
      path: "notes.md",
      content: "# Initial\n",
      contentHash: initialHash,
      diskHash: initialHash,
      isDirty: false,
      hasExternalConflict: false,
    });
    expect(state.workspace.hashFile("notes.md")).toBe(initialHash);

    // Edit makes buffer dirty without writing to disk.
    const edited = state.updateBuffer("notes.md", "# Initial\nUnsaved line\n");
    expect(edited.isDirty).toBe(true);
    expect(edited.contentHash).toBe(hashContent("# Initial\nUnsaved line\n"));
    expect(edited.diskHash).toBe(initialHash);
    expect(fs.readFileSync(path.join(dir, "notes.md"), "utf8")).toBe("# Initial\n");

    // Reverting/undoing back to the exact disk text returns isDirty to false.
    const reverted = state.updateBuffer("notes.md", "# Initial\n");
    expect(reverted.isDirty).toBe(false);
    expect(reverted.contentHash).toBe(initialHash);
    expect(reverted.diskHash).toBe(initialHash);
  });

  it("guards against switching or closing a dirty buffer unless discardDirty is true", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "a.md"), "A");
    fs.writeFileSync(path.join(dir, "b.md"), "B");

    const state = WorkspaceState.open(dir);
    state.openFile("a.md");
    state.updateBuffer("a.md", "A edited");

    // Re-opening the same active file returns the live buffer untouched.
    const same = state.openFile("./a.md");
    expect(same.content).toBe("A edited");
    expect(same.isDirty).toBe(true);

    // Switching away or closing while dirty throws UnsavedChanges.
    expectErrorCode(() => state.openFile("b.md"), "UnsavedChanges");
    expectErrorCode(() => state.closeActiveFile(), "UnsavedChanges");
    expect(state.activeFile?.path).toBe("a.md");

    // Explicit discardDirty switches cleanly.
    const switched = state.openFile("b.md", { discardDirty: true });
    expect(switched.path).toBe("b.md");
    expect(switched.content).toBe("B");
    expect(switched.isDirty).toBe(false);

    // Closing a clean buffer succeeds; closing with nothing open is a no-op.
    state.closeActiveFile();
    expect(state.activeFile).toBeNull();
    state.closeActiveFile();

    // Closing a dirty buffer with discardDirty succeeds.
    state.openFile("b.md");
    state.updateBuffer("b.md", "B edited");
    state.closeActiveFile({ discardDirty: true });
    expect(state.activeFile).toBeNull();
  });

  it("validates active file state and sandbox paths on buffer updates and opens", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/a.md"), "A");
    fs.writeFileSync(path.join(dir, "docs/b.md"), "B");

    const state = WorkspaceState.open(dir);

    expectErrorCode(() => state.updateBuffer("docs/a.md", "nope"), "NoOpenFile");
    expectErrorCode(() => state.saveActiveFile(), "NoOpenFile");
    expectErrorCode(() => state.reloadActiveFile(), "NoOpenFile");

    state.openFile("docs/a.md");
    expectErrorCode(() => state.updateBuffer("docs/b.md", "wrong"), "ActiveFileMismatch");
    expectErrorCode(() => state.updateBuffer("../escape.md", "escape"), "PathOutsideRoot");
    expectErrorCode(() => state.openFile("../escape.md"), "PathOutsideRoot");

    // Failing to open a nonexistent file preserves the currently open buffer.
    expectErrorCode(() => state.openFile("docs/missing.md"), "NotFound");
    expect(state.activeFile?.path).toBe("docs/a.md");

    // Normalized relative path segments targeting the same file work.
    const updated = state.updateBuffer("docs/../docs/a.md", "A2");
    expect(updated.content).toBe("A2");
  });

  it("saves atomically, updates diskHash, and treats post-save sync as unchanged", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "notes.md"), "v1");

    const state = WorkspaceState.open(dir);
    state.openFile("notes.md");
    state.updateBuffer("notes.md", "v2");

    const result = state.saveActiveFile();
    expect(result.status).toBe("saved");
    if (result.status === "saved") {
      expect(result.buffer.content).toBe("v2");
      expect(result.buffer.isDirty).toBe(false);
      expect(result.buffer.hasExternalConflict).toBe(false);
      expect(result.buffer.diskHash).toBe(hashContent("v2"));
    }
    expect(fs.readFileSync(path.join(dir, "notes.md"), "utf8")).toBe("v2");

    // Watcher echo after our own atomic save is treated as unchanged.
    const sync = state.syncActiveFileWithDisk();
    expect(sync.status).toBe("unchanged");
  });

  it("detects external disk divergence on saveActiveFile and resolves via force or reload", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "notes.md");
    fs.writeFileSync(filePath, "base");

    const state = WorkspaceState.open(dir);
    state.openFile("notes.md");
    state.updateBuffer("notes.md", "local edit");

    // External tool edits disk before user saves.
    fs.writeFileSync(filePath, "external edit");

    const conflictSave = state.saveActiveFile();
    expect(conflictSave.status).toBe("conflict");
    if (conflictSave.status === "conflict") {
      expect(conflictSave.diskHash).toBe(hashContent("external edit"));
      expect(conflictSave.buffer.hasExternalConflict).toBe(true);
      expect(conflictSave.buffer.isDirty).toBe(true);
      expect(conflictSave.buffer.content).toBe("local edit");
    }
    // Disk was NOT overwritten.
    expect(fs.readFileSync(filePath, "utf8")).toBe("external edit");

    // Even if the user undoes back to "base" while conflicted, buffer stays dirty & conflicted
    // because disk holds "external edit".
    const undone = state.updateBuffer("notes.md", "base");
    expect(undone.hasExternalConflict).toBe(true);
    expect(undone.isDirty).toBe(true);

    // Force save (Keep Local) writes local content and clears conflict.
    state.updateBuffer("notes.md", "kept local");
    const forced = state.saveActiveFile({ force: true });
    expect(forced.status).toBe("saved");
    if (forced.status === "saved") {
      expect(forced.buffer.isDirty).toBe(false);
      expect(forced.buffer.hasExternalConflict).toBe(false);
      expect(forced.buffer.diskHash).toBe(hashContent("kept local"));
    }
    expect(fs.readFileSync(filePath, "utf8")).toBe("kept local");

    // Now test Reload path on another conflict.
    state.updateBuffer("notes.md", "another local edit");
    fs.writeFileSync(filePath, "fresh external");
    const conflict2 = state.saveActiveFile();
    expect(conflict2.status).toBe("conflict");

    const reloaded = state.reloadActiveFile();
    expect(reloaded).toEqual({
      path: "notes.md",
      content: "fresh external",
      contentHash: hashContent("fresh external"),
      diskHash: hashContent("fresh external"),
      isDirty: false,
      hasExternalConflict: false,
    });
  });

  it("silently reloads clean buffers on external disk edit and flags conflicts on dirty buffers", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "notes.md");
    fs.writeFileSync(filePath, "v1");

    const state = WorkspaceState.open(dir);
    expect(state.syncActiveFileWithDisk()).toEqual({ status: "no_open_file" });

    state.openFile("notes.md");
    expect(state.syncActiveFileWithDisk().status).toBe("unchanged");

    // Clean + external edit => silently reloaded.
    fs.writeFileSync(filePath, "v2 external");
    const reloaded = state.syncActiveFileWithDisk();
    expect(reloaded.status).toBe("reloaded");
    if (reloaded.status === "reloaded") {
      expect(reloaded.buffer.content).toBe("v2 external");
      expect(reloaded.buffer.diskHash).toBe(hashContent("v2 external"));
      expect(reloaded.buffer.isDirty).toBe(false);
      expect(reloaded.buffer.hasExternalConflict).toBe(false);
    }

    // Dirty + external edit => conflict.
    state.updateBuffer("notes.md", "v3 local");
    fs.writeFileSync(filePath, "v3 external");
    const conflict = state.syncActiveFileWithDisk();
    expect(conflict.status).toBe("conflict");
    if (conflict.status === "conflict") {
      expect(conflict.diskHash).toBe(hashContent("v3 external"));
      expect(conflict.buffer.content).toBe("v3 local");
      expect(conflict.buffer.hasExternalConflict).toBe(true);
      expect(conflict.buffer.isDirty).toBe(true);
    }
  });

  it("handles external deletion: closes when clean, conflicts when dirty, and preserves buffer on reload NotFound", () => {
    const dir = makeTempDir();
    const cleanFile = path.join(dir, "clean.md");
    const dirtyFile = path.join(dir, "dirty.md");
    fs.writeFileSync(cleanFile, "clean content");
    fs.writeFileSync(dirtyFile, "dirty base");

    const state = WorkspaceState.open(dir);

    // Clean file deleted externally => closed cleanly.
    state.openFile("clean.md");
    fs.unlinkSync(cleanFile);
    expect(state.syncActiveFileWithDisk()).toEqual({ status: "deleted", path: "clean.md" });
    expect(state.activeFile).toBeNull();

    // Dirty file deleted externally => stays open in ExternalConflict with diskHash: null.
    state.openFile("dirty.md");
    state.updateBuffer("dirty.md", "important unsaved draft");
    fs.unlinkSync(dirtyFile);

    const syncConflict = state.syncActiveFileWithDisk();
    expect(syncConflict.status).toBe("conflict");
    if (syncConflict.status === "conflict") {
      expect(syncConflict.diskHash).toBeNull();
      expect(syncConflict.buffer.hasExternalConflict).toBe(true);
      expect(syncConflict.buffer.content).toBe("important unsaved draft");
    }

    // Non-forced save also reports conflict with diskHash: null without silently recreating.
    const saveConflict = state.saveActiveFile();
    expect(saveConflict.status).toBe("conflict");
    if (saveConflict.status === "conflict") {
      expect(saveConflict.diskHash).toBeNull();
    }
    expect(fs.existsSync(dirtyFile)).toBe(false);

    // reloadActiveFile() throws NotFound and preserves the dirty in-memory buffer intact.
    expectErrorCode(() => state.reloadActiveFile(), "NotFound");
    expect(state.activeFile).not.toBeNull();
    expect(state.activeFile?.content).toBe("important unsaved draft");
    expect(state.activeFile?.hasExternalConflict).toBe(true);

    // Live reads and searches still reflect the in-memory draft while open.
    expect(state.readFile("dirty.md")).toEqual({
      path: "dirty.md",
      content: "important unsaved draft",
      contentHash: hashContent("important unsaved draft"),
      isDirty: true,
    });
    expect(state.searchFiles("unsaved draft")).toEqual([
      { path: "dirty.md", line: 1, snippet: "important unsaved draft" },
    ]);

    // Keep Local via force save re-creates the file on disk and clears conflict.
    const saved = state.saveActiveFile({ force: true });
    expect(saved.status).toBe("saved");
    expect(fs.readFileSync(dirtyFile, "utf8")).toBe("important unsaved draft");
    expect(state.activeFile?.isDirty).toBe(false);
    expect(state.activeFile?.hasExternalConflict).toBe(false);
  });

  it("serves live unsaved buffer content in readFile, hashFile, and searchFiles", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "a.md"), "alpha disk line\nshared keyword");
    fs.writeFileSync(path.join(dir, "b.md"), "beta disk line\nshared keyword");

    const ws = Workspace.open(dir);
    const state = new WorkspaceState(ws);

    // Before opening, readFile reads from disk with isDirty: false.
    expect(state.readFile("a.md")).toEqual({
      path: "a.md",
      content: "alpha disk line\nshared keyword",
      contentHash: hashContent("alpha disk line\nshared keyword"),
      isDirty: false,
    });

    state.openFile("a.md");
    state.updateBuffer("a.md", "alpha LIVE buffer\nonly in memory");

    // readFile and hashFile return live buffer for active file, disk for others.
    expect(state.readFile("a.md")).toEqual({
      path: "a.md",
      content: "alpha LIVE buffer\nonly in memory",
      contentHash: hashContent("alpha LIVE buffer\nonly in memory"),
      isDirty: true,
    });
    expect(state.hashFile("a.md")).toBe(hashContent("alpha LIVE buffer\nonly in memory"));
    expect(state.readFile("b.md").isDirty).toBe(false);
    expect(state.hashFile("b.md")).toBe(hashContent("beta disk line\nshared keyword"));

    // searchFiles finds text added only in memory and omits text removed from the live buffer.
    expect(state.searchFiles("live buffer")).toEqual([
      { path: "a.md", line: 1, snippet: "alpha LIVE buffer" },
    ]);
    expect(state.searchFiles("alpha disk line")).toEqual([]);
    expect(state.searchFiles("shared keyword")).toEqual([
      { path: "b.md", line: 2, snippet: "shared keyword" },
    ]);

    // Non-file and unsupported paths keep standard WorkspaceError semantics.
    fs.mkdirSync(path.join(dir, "folder"));
    fs.writeFileSync(path.join(dir, "plain.txt"), "text");
    expectErrorCode(() => state.readFile("folder"), "NotAFile");
    expectErrorCode(() => state.readFile("plain.txt"), "UnsupportedFileType");
    expectErrorCode(() => state.readFile("missing.md"), "NotFound");
  });

  it.skipIf(process.platform === "win32")(
    "matches internal symlink aliases to the active buffer and blocks escaping symlinks",
    () => {
      const outside = makeTempDir();
      fs.writeFileSync(path.join(outside, "secret.md"), "secret");

      const dir = makeTempDir();
      fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
      fs.writeFileSync(path.join(dir, "sub/real.md"), "original");
      fs.symlinkSync(path.join(dir, "sub/real.md"), path.join(dir, "alias.md"));
      fs.symlinkSync(path.join(outside, "secret.md"), path.join(dir, "escape.md"));

      const state = WorkspaceState.open(dir);

      expectErrorCode(() => state.openFile("escape.md"), "PathOutsideRoot");
      expectErrorCode(() => state.readFile("escape.md"), "PathOutsideRoot");

      state.openFile("sub/real.md");
      state.updateBuffer("alias.md", "edited via alias");

      // Both canonical path and alias reflect the live unsaved buffer.
      expect(state.readFile("sub/real.md").content).toBe("edited via alias");
      expect(state.readFile("alias.md")).toEqual({
        path: "alias.md",
        content: "edited via alias",
        contentHash: hashContent("edited via alias"),
        isDirty: true,
      });
      expect(state.openFile("alias.md").content).toBe("edited via alias");

      // Search reflects live buffer content under both listed paths.
      expect(state.searchFiles("edited via alias")).toEqual([
        { path: "alias.md", line: 1, snippet: "edited via alias" },
        { path: "sub/real.md", line: 1, snippet: "edited via alias" },
      ]);
    },
  );
});

describe("WorkspaceState proposals", () => {
  it("never modifies disk on proposeEdit and replaces an existing proposal for the same file", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    const filePath = path.join(dir, "docs/notes.md");
    fs.writeFileSync(filePath, "# Title\nOriginal line\n");

    const state = WorkspaceState.open(dir);
    expect(state.proposals.size).toBe(0);

    const first = state.proposeEdit(
      "./docs/notes.md",
      "# Title\nFirst draft\n",
      "Initial rewrite",
    );

    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(first.path).toBe("docs/notes.md");
    expect(first.baseHash).toBe(hashContent("# Title\nOriginal line\n"));
    expect(first.proposedContent).toBe("# Title\nFirst draft\n");
    expect(first.reason).toBe("Initial rewrite");
    expect(first.diffLines).toEqual([
      { type: "context", value: "# Title" },
      { type: "removed", value: "Original line" },
      { type: "added", value: "First draft" },
    ]);
    expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false);
    expect(state.proposals.size).toBe(1);
    expect(state.getProposal(first.id)).toEqual(first);
    expect(state.getProposalForPath("docs/notes.md")).toEqual(first);

    // Disk must remain completely untouched.
    expect(fs.readFileSync(filePath, "utf8")).toBe("# Title\nOriginal line\n");

    // A second proposal targeting the same file (even via a non-canonical relative path)
    // replaces the previous proposal.
    const second = state.proposeEdit(
      "docs/../docs/notes.md",
      "# Title\nSecond draft\n",
      "Refined rewrite",
    );

    expect(second.id).not.toBe(first.id);
    expect(second.path).toBe("docs/notes.md");
    expect(second.reason).toBe("Refined rewrite");
    expect(state.proposals.size).toBe(1);
    expect(state.getProposal(first.id)).toBeNull();
    expect(state.getProposal(second.id)).toEqual(second);
    expect(state.getProposalForPath("docs/notes.md")).toEqual(second);
    expect(fs.readFileSync(filePath, "utf8")).toBe("# Title\nOriginal line\n");

    // Sandbox and file-type validation still apply.
    fs.writeFileSync(path.join(dir, "plain.txt"), "hello");
    expectErrorCode(() => state.proposeEdit("../escape.md", "x", "bad"), "PathOutsideRoot");
    expectErrorCode(() => state.proposeEdit("plain.txt", "x", "bad"), "UnsupportedFileType");
    expectErrorCode(() => state.proposeEdit("docs/missing.md", "x", "bad"), "NotFound");
    expectErrorCode(() => state.proposeEdit("docs", "x", "bad"), "UnsupportedFileType");
  });

  it("computes baseHash and diffLines against the live unsaved buffer on a dirty open file", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "notes.md");
    fs.writeFileSync(filePath, "# Notes\nDisk line\n");

    const state = WorkspaceState.open(dir);
    state.openFile("notes.md");
    state.updateBuffer("notes.md", "# Notes\nLive unsaved line\n");

    const proposal = state.proposeEdit(
      "notes.md",
      "# Notes\nLive unsaved line\nAdded by agent\n",
      "Append agent summary",
    );

    expect(proposal.baseHash).toBe(hashContent("# Notes\nLive unsaved line\n"));
    expect(proposal.baseHash).not.toBe(hashContent("# Notes\nDisk line\n"));
    expect(proposal.diffLines).toEqual([
      { type: "context", value: "# Notes" },
      { type: "context", value: "Live unsaved line" },
      { type: "added", value: "Added by agent" },
    ]);
    // Disk still holds the original saved text and open buffer stays dirty.
    expect(fs.readFileSync(filePath, "utf8")).toBe("# Notes\nDisk line\n");
    expect(state.activeFile?.isDirty).toBe(true);
  });

  it("accepts a matching proposal, writes to disk, updates openFile, and clears isDirty", () => {
    const dir = makeTempDir();
    const openPath = path.join(dir, "open.md");
    const closedPath = path.join(dir, "closed.md");
    fs.writeFileSync(openPath, "disk v1\n");
    fs.writeFileSync(closedPath, "closed v1\n");

    const state = WorkspaceState.open(dir);
    state.openFile("open.md");
    state.updateBuffer("open.md", "unsaved v2\n");

    const openProposal = state.proposeEdit("open.md", "proposed v3\n", "Apply v3");
    const closedProposal = state.proposeEdit("closed.md", "closed v2\n", "Update closed");

    // Accepting a proposal for a non-open file writes disk and leaves the active file intact.
    const closedResult = state.acceptProposal(closedProposal.id);
    expect(closedResult).toEqual({
      status: "accepted",
      id: closedProposal.id,
      path: "closed.md",
      openFile: null,
    });
    expect(fs.readFileSync(closedPath, "utf8")).toBe("closed v2\n");
    expect(state.getProposal(closedProposal.id)).toBeNull();
    expect(state.activeFile?.path).toBe("open.md");
    expect(state.activeFile?.isDirty).toBe(true);

    // Accepting the open file's proposal writes to disk, updates openFile, and clears isDirty.
    const openResult = state.acceptProposal(openProposal.id);
    const expectedHash = hashContent("proposed v3\n");
    expect(openResult).toEqual({
      status: "accepted",
      id: openProposal.id,
      path: "open.md",
      openFile: {
        path: "open.md",
        content: "proposed v3\n",
        contentHash: expectedHash,
        diskHash: expectedHash,
        isDirty: false,
        hasExternalConflict: false,
      },
    });
    expect(fs.readFileSync(openPath, "utf8")).toBe("proposed v3\n");
    expect(state.activeFile).toEqual(openResult.status === "accepted" ? openResult.openFile : null);
    expect(state.proposals.size).toBe(0);
  });

  it("returns conflict when edited afterward and succeeds when accepted with force: true", () => {
    const dir = makeTempDir();
    const openPath = path.join(dir, "notes.md");
    const closedPath = path.join(dir, "other.md");
    fs.writeFileSync(openPath, "initial\n");
    fs.writeFileSync(closedPath, "other v1\n");

    const state = WorkspaceState.open(dir);
    state.openFile("notes.md");
    const proposal = state.proposeEdit("notes.md", "agent version\n", "Rewrite note");

    // User edits the open file after the proposal arrived.
    state.updateBuffer("notes.md", "user newer edit\n");

    const conflict = state.acceptProposal(proposal.id);
    expect(conflict).toEqual({
      status: "conflict",
      proposal,
      currentHash: hashContent("user newer edit\n"),
    });
    // Proposal stays in the queue; disk and live buffer are untouched.
    expect(state.proposals.size).toBe(1);
    expect(state.getProposal(proposal.id)).toEqual(proposal);
    expect(fs.readFileSync(openPath, "utf8")).toBe("initial\n");
    expect(state.activeFile?.content).toBe("user newer edit\n");
    expect(state.activeFile?.isDirty).toBe(true);

    // Accepting with force: true overwrites disk, updates openFile cleanly, and removes proposal.
    const forced = state.acceptProposal(proposal.id, { force: true });
    const agentHash = hashContent("agent version\n");
    expect(forced).toEqual({
      status: "accepted",
      id: proposal.id,
      path: "notes.md",
      openFile: {
        path: "notes.md",
        content: "agent version\n",
        contentHash: agentHash,
        diskHash: agentHash,
        isDirty: false,
        hasExternalConflict: false,
      },
    });
    expect(fs.readFileSync(openPath, "utf8")).toBe("agent version\n");
    expect(state.proposals.size).toBe(0);

    // External deletion of a closed file also triggers conflict with currentHash: null.
    const deletedProposal = state.proposeEdit("other.md", "recreated\n", "Update other");
    fs.unlinkSync(closedPath);
    const deletedConflict = state.acceptProposal(deletedProposal.id);
    expect(deletedConflict).toEqual({
      status: "conflict",
      proposal: deletedProposal,
      currentHash: null,
    });
    expect(state.getProposal(deletedProposal.id)).toEqual(deletedProposal);

    // Force-accepting recreates the file cleanly.
    const recreated = state.acceptProposal(deletedProposal.id, { force: true });
    expect(recreated.status).toBe("accepted");
    expect(fs.readFileSync(closedPath, "utf8")).toBe("recreated\n");
  });

  it("rejects a proposal without touching disk or openFile and errors on unknown IDs", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "notes.md");
    fs.writeFileSync(filePath, "saved\n");

    const state = WorkspaceState.open(dir);
    state.openFile("notes.md");
    state.updateBuffer("notes.md", "unsaved draft\n");

    const proposal = state.proposeEdit("notes.md", "agent edit\n", "Polish");
    const rejected = state.rejectProposal(proposal.id);

    expect(rejected).toEqual(proposal);
    expect(state.proposals.size).toBe(0);
    expect(state.getProposalForPath("notes.md")).toBeNull();
    expect(fs.readFileSync(filePath, "utf8")).toBe("saved\n");
    expect(state.activeFile?.content).toBe("unsaved draft\n");
    expect(state.activeFile?.isDirty).toBe(true);

    expectErrorCode(() => state.rejectProposal(proposal.id), "ProposalNotFound");
    expectErrorCode(() => state.acceptProposal("missing-id"), "ProposalNotFound");
  });

  it("applies clean proposals and keeps conflicted proposals queued in acceptAllProposals", () => {
    const dir = makeTempDir();
    const aPath = path.join(dir, "a.md");
    const bPath = path.join(dir, "b.md");
    const cPath = path.join(dir, "c.md");
    fs.writeFileSync(aPath, "A v1\n");
    fs.writeFileSync(bPath, "B v1\n");
    fs.writeFileSync(cPath, "C v1\n");

    const state = WorkspaceState.open(dir);
    state.openFile("a.md");

    const propA = state.proposeEdit("a.md", "A v2\n", "Update A");
    const propB = state.proposeEdit("b.md", "B v2\n", "Update B");
    const propC = state.proposeEdit("c.md", "C v2\n", "Update C");

    // Introduce a conflict only on b.md (on disk).
    fs.writeFileSync(bPath, "B edited externally\n");

    const batch = state.acceptAllProposals();

    expect(batch.accepted).toHaveLength(2);
    expect(batch.accepted.map((item) => item.path)).toEqual(["a.md", "c.md"]);
    expect(batch.accepted[0]?.id).toBe(propA.id);
    expect(batch.accepted[0]?.openFile?.content).toBe("A v2\n");
    expect(batch.accepted[0]?.openFile?.isDirty).toBe(false);
    expect(batch.accepted[1]?.id).toBe(propC.id);
    expect(batch.accepted[1]?.openFile).toBeNull();

    expect(batch.conflicted).toEqual([
      {
        status: "conflict",
        proposal: propB,
        currentHash: hashContent("B edited externally\n"),
      },
    ]);

    // Clean proposals were written to disk; conflicted file was NOT overwritten and stays queued.
    expect(fs.readFileSync(aPath, "utf8")).toBe("A v2\n");
    expect(fs.readFileSync(bPath, "utf8")).toBe("B edited externally\n");
    expect(fs.readFileSync(cPath, "utf8")).toBe("C v2\n");
    expect(state.activeFile?.content).toBe("A v2\n");
    expect(state.activeFile?.isDirty).toBe(false);

    expect(state.proposals.size).toBe(1);
    expect(state.listProposals()).toEqual([propB]);
  });

  it.skipIf(process.platform === "win32")(
    "enforces one proposal per canonical file across internal symlink aliases",
    () => {
      const dir = makeTempDir();
      fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
      fs.writeFileSync(path.join(dir, "sub/real.md"), "base\n");
      fs.symlinkSync(path.join(dir, "sub/real.md"), path.join(dir, "alias.md"));

      const state = WorkspaceState.open(dir);
      const p1 = state.proposeEdit("sub/real.md", "v1\n", "First");
      const p2 = state.proposeEdit("alias.md", "v2\n", "Second via alias");

      expect(state.proposals.size).toBe(1);
      expect(state.getProposal(p1.id)).toBeNull();
      expect(state.getProposal(p2.id)).toEqual(p2);
      expect(state.getProposalForPath("sub/real.md")).toEqual(p2);
    },
  );
});
