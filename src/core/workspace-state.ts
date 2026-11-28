import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeLineDiff, type DiffLine } from "./diff";
import { WorkspaceError } from "./error";
import { hashContent } from "./hash";
import * as sandbox from "./sandbox";
import { matchContentLines, Workspace, type SearchMatch } from "./workspace";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Read-only snapshot of the single currently open Markdown file buffer. */
export interface OpenFileBuffer {
  /** Forward-slash path relative to the workspace root. */
  readonly path: string;
  /** Live in-memory Markdown content. */
  readonly content: string;
  /** Lowercase SHA-256 hex digest of `content`. */
  readonly contentHash: string;
  /** Lowercase SHA-256 hex digest of the last loaded or saved disk snapshot. */
  readonly diskHash: string;
  /** Whether the buffer differs from its disk snapshot or has an unresolved external conflict. */
  readonly isDirty: boolean;
  /** Whether the file changed or was deleted on disk while the buffer had unsaved edits. */
  readonly hasExternalConflict: boolean;
}

/** Result returned by `WorkspaceState.readFile`, reflecting live unsaved edits when active. */
export interface ReadFileResult {
  /** Forward-slash path relative to the workspace root. */
  readonly path: string;
  /** File content (live in-memory buffer if open, otherwise disk). */
  readonly content: string;
  /** Lowercase SHA-256 hex digest of `content`. */
  readonly contentHash: string;
  /** Whether the content comes from an unsaved or conflicted in-memory buffer. */
  readonly isDirty: boolean;
}

/** Options controlling `WorkspaceState.openFile`. */
export interface OpenFileOptions {
  /** When `true`, discards unsaved edits in the currently open file before switching. */
  discardDirty?: boolean;
}

/** Options controlling `WorkspaceState.closeActiveFile`. */
export interface CloseActiveFileOptions {
  /** When `true`, discards unsaved edits in the currently open file when closing. */
  discardDirty?: boolean;
}

/** Options controlling `WorkspaceState.saveActiveFile`. */
export interface SaveActiveFileOptions {
  /** When `true`, overwrites disk even if the file changed or was deleted externally (Keep Local). */
  force?: boolean;
}

/** Discriminated outcome returned by `WorkspaceState.saveActiveFile`. */
export type SaveActiveFileResult =
  | { readonly status: "saved"; readonly buffer: OpenFileBuffer }
  | {
      readonly status: "conflict";
      readonly buffer: OpenFileBuffer;
      /** Current SHA-256 hex digest on disk, or `null` if the file was deleted externally. */
      readonly diskHash: string | null;
    };

/** Discriminated outcome returned by `WorkspaceState.syncActiveFileWithDisk`. */
export type DiskSyncResult =
  | { readonly status: "no_open_file" }
  | { readonly status: "unchanged"; readonly buffer: OpenFileBuffer }
  | { readonly status: "reloaded"; readonly buffer: OpenFileBuffer }
  | { readonly status: "deleted"; readonly path: string }
  | {
      readonly status: "conflict";
      readonly buffer: OpenFileBuffer;
      /** Current SHA-256 hex digest on disk, or `null` if the file was deleted externally. */
      readonly diskHash: string | null;
    };

/** A staged edit proposal awaiting explicit user approval. */
export interface PendingChange {
  /** Unique UUID identifying this proposal. */
  readonly id: string;
  /** Forward-slash path relative to the workspace root. */
  readonly path: string;
  /** SHA-256 hex digest of the file content at proposal time (live buffer if open, else disk). */
  readonly baseHash: string;
  /** Full proposed Markdown content to write if accepted. */
  readonly proposedContent: string;
  /** Human-readable explanation of why the edit was proposed. */
  readonly reason: string;
  /** Line-by-line diff from the base content to `proposedContent`. */
  readonly diffLines: readonly DiffLine[];
  /** ISO-8601 timestamp when the proposal was created. */
  readonly createdAt: string;
}

/** Options controlling `WorkspaceState.acceptProposal`. */
export interface AcceptProposalOptions {
  /** When `true`, overwrites the file even if its content hash changed since proposal time. */
  force?: boolean;
}

/** Outcome when a proposal is cleanly applied (or force-applied) to disk. */
export interface AcceptedProposalResult {
  readonly status: "accepted";
  readonly id: string;
  readonly path: string;
  /** Updated open file snapshot if the accepted file is currently open, otherwise `null`. */
  readonly openFile: OpenFileBuffer | null;
}

/** Outcome when accepting a proposal is blocked because the file changed since proposal time. */
export interface ConflictedProposalResult {
  readonly status: "conflict";
  readonly proposal: PendingChange;
  /** Current SHA-256 hex digest of the file (live buffer if open, else disk), or `null` if deleted on disk. */
  readonly currentHash: string | null;
}

/** Discriminated outcome returned by `WorkspaceState.acceptProposal`. */
export type AcceptProposalResult = AcceptedProposalResult | ConflictedProposalResult;

/** Outcome returned by `WorkspaceState.acceptAllProposals`. */
export interface AcceptAllProposalsResult {
  readonly accepted: readonly AcceptedProposalResult[];
  readonly conflicted: readonly ConflictedProposalResult[];
}

interface InternalBuffer {
  path: string;
  canonicalPath: string;
  content: string;
  contentHash: string;
  diskHash: string;
  hasExternalConflict: boolean;
}

interface InternalProposal {
  readonly id: string;
  readonly path: string;
  readonly canonicalPath: string;
  readonly baseHash: string;
  readonly proposedContent: string;
  readonly reason: string;
  readonly diffLines: readonly DiffLine[];
  readonly createdAt: string;
}

function getErrnoCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function toForwardSlashRelative(relPath: string): string {
  return sandbox.normalizeRelative(relPath).split(path.sep).join("/");
}

function computeIsDirty(buffer: InternalBuffer): boolean {
  return buffer.contentHash !== buffer.diskHash || buffer.hasExternalConflict;
}

function toSnapshot(buffer: InternalBuffer): OpenFileBuffer {
  return {
    path: buffer.path,
    content: buffer.content,
    contentHash: buffer.contentHash,
    diskHash: buffer.diskHash,
    isDirty: computeIsDirty(buffer),
    hasExternalConflict: buffer.hasExternalConflict,
  };
}

function toProposalSnapshot(proposal: InternalProposal): PendingChange {
  return {
    id: proposal.id,
    path: proposal.path,
    baseHash: proposal.baseHash,
    proposedContent: proposal.proposedContent,
    reason: proposal.reason,
    diffLines: proposal.diffLines.map((line) => ({ ...line })),
    createdAt: proposal.createdAt,
  };
}

/**
 * Stateful workspace controller owning the active in-memory file buffer and
 * pending edit proposal queue on top of a sandboxed `Workspace`.
 */
export class WorkspaceState {
  readonly workspace: Workspace;
  private activeBuffer: InternalBuffer | null = null;
  private readonly pendingProposals = new Map<string, InternalProposal>();
  private readonly proposalIdByCanonicalPath = new Map<string, string>();

  constructor(workspace: Workspace) {
    this.workspace = workspace;
  }

  /** Opens a workspace at `rootPath` and wraps it in a new `WorkspaceState`. */
  static open(rootPath: string): WorkspaceState {
    return new WorkspaceState(Workspace.open(rootPath));
  }

  /** Canonical root directory of the underlying workspace. */
  get root(): string {
    return this.workspace.root;
  }

  /** Read-only snapshot of the currently open file buffer, or `null` if none is open. */
  get activeFile(): OpenFileBuffer | null {
    return this.activeBuffer ? toSnapshot(this.activeBuffer) : null;
  }

  /** Read-only snapshot of all pending proposals keyed by proposal UUID. */
  get proposals(): ReadonlyMap<string, PendingChange> {
    const snapshot = new Map<string, PendingChange>();
    for (const [id, proposal] of this.pendingProposals) {
      snapshot.set(id, toProposalSnapshot(proposal));
    }
    return snapshot;
  }

  /** Returns all pending proposals in insertion order. */
  listProposals(): PendingChange[] {
    return Array.from(this.pendingProposals.values(), toProposalSnapshot);
  }

  /** Returns a snapshot of the pending proposal with the given `id`, or `null` if absent. */
  getProposal(id: string): PendingChange | null {
    const proposal = this.pendingProposals.get(id);
    return proposal ? toProposalSnapshot(proposal) : null;
  }

  /** Returns the pending proposal targeting `relPath`, or `null` if none exists. */
  getProposalForPath(relPath: string): PendingChange | null {
    const { normalized, resolved } = this.validatePathInSandbox(relPath);
    const id = this.proposalIdByCanonicalPath.get(resolved);
    if (id !== undefined) {
      const proposal = this.pendingProposals.get(id);
      if (proposal) {
        return toProposalSnapshot(proposal);
      }
    }
    for (const proposal of this.pendingProposals.values()) {
      if (proposal.path === normalized) {
        return toProposalSnapshot(proposal);
      }
    }
    return null;
  }

  /**
   * Opens a `.md` file into the single active in-memory buffer.
   *
   * Re-opening the currently active file returns the live buffer unchanged.
   * Switching away from a dirty buffer throws `WorkspaceError("UnsavedChanges")`
   * unless `options.discardDirty` is `true`.
   */
  openFile(relPath: string, options?: OpenFileOptions): OpenFileBuffer {
    const { normalized, resolved } = this.validatePathInSandbox(relPath);

    if (this.activeBuffer && this.matchesActive(normalized, resolved)) {
      return toSnapshot(this.activeBuffer);
    }

    if (this.activeBuffer && computeIsDirty(this.activeBuffer) && !options?.discardDirty) {
      throw WorkspaceError.unsavedChanges(this.activeBuffer.path);
    }

    const content = this.workspace.readFile(relPath);
    const canonicalPath = sandbox.resolveExisting(this.workspace.root, relPath);
    const diskHash = hashContent(content);

    this.activeBuffer = {
      path: normalized,
      canonicalPath,
      content,
      contentHash: diskHash,
      diskHash,
      hasExternalConflict: false,
    };

    return toSnapshot(this.activeBuffer);
  }

  /**
   * Closes the currently active file buffer.
   *
   * Throws `WorkspaceError("UnsavedChanges")` if the active buffer is dirty
   * unless `options.discardDirty` is `true`.
   */
  closeActiveFile(options?: CloseActiveFileOptions): void {
    if (!this.activeBuffer) {
      return;
    }
    if (computeIsDirty(this.activeBuffer) && !options?.discardDirty) {
      throw WorkspaceError.unsavedChanges(this.activeBuffer.path);
    }
    this.activeBuffer = null;
  }

  /**
   * Updates the live in-memory text for the currently open file and recomputes
   * its SHA-256 content hash and derived dirty state.
   */
  updateBuffer(relPath: string, content: string): OpenFileBuffer {
    if (!this.activeBuffer) {
      throw WorkspaceError.noOpenFile();
    }

    const { normalized, resolved } = this.validatePathInSandbox(relPath);
    if (!this.matchesActive(normalized, resolved)) {
      throw WorkspaceError.activeFileMismatch(relPath, this.activeBuffer.path);
    }

    const contentHash = hashContent(content);
    this.activeBuffer.content = content;
    this.activeBuffer.contentHash = contentHash;

    return toSnapshot(this.activeBuffer);
  }

  /**
   * Saves the active in-memory buffer atomically to disk.
   *
   * Unless `options.force` is `true`, verifies the current disk hash still matches
   * `diskHash`. If the file changed or was deleted externally, flags
   * `hasExternalConflict` and returns `{ status: "conflict", ... }` without writing.
   */
  saveActiveFile(options?: SaveActiveFileOptions): SaveActiveFileResult {
    if (!this.activeBuffer) {
      throw WorkspaceError.noOpenFile();
    }

    const force = options?.force === true;
    if (!force) {
      const currentDiskHash = this.readDiskHashOrNull(this.activeBuffer.path);
      if (currentDiskHash !== this.activeBuffer.diskHash) {
        this.activeBuffer.hasExternalConflict = true;
        return {
          status: "conflict",
          buffer: toSnapshot(this.activeBuffer),
          diskHash: currentDiskHash,
        };
      }
    }

    this.workspace.saveFile(this.activeBuffer.path, this.activeBuffer.content);
    this.activeBuffer.canonicalPath = sandbox.resolveExisting(
      this.workspace.root,
      this.activeBuffer.path,
    );
    this.activeBuffer.diskHash = this.activeBuffer.contentHash;
    this.activeBuffer.hasExternalConflict = false;

    return {
      status: "saved",
      buffer: toSnapshot(this.activeBuffer),
    };
  }

  /**
   * Discards unsaved local edits and reloads the active file from disk.
   *
   * If the file was deleted externally on disk, throws `WorkspaceError("NotFound")`
   * while leaving the active in-memory buffer intact so unsaved work is not lost.
   */
  reloadActiveFile(): OpenFileBuffer {
    if (!this.activeBuffer) {
      throw WorkspaceError.noOpenFile();
    }

    const content = this.workspace.readFile(this.activeBuffer.path);
    const canonicalPath = sandbox.resolveExisting(this.workspace.root, this.activeBuffer.path);
    const diskHash = hashContent(content);

    this.activeBuffer.canonicalPath = canonicalPath;
    this.activeBuffer.content = content;
    this.activeBuffer.contentHash = diskHash;
    this.activeBuffer.diskHash = diskHash;
    this.activeBuffer.hasExternalConflict = false;

    return toSnapshot(this.activeBuffer);
  }

  /**
   * Reconciles the active buffer against the current file on disk (intended to
   * be invoked by the file watcher or explicit sync checks).
   */
  syncActiveFileWithDisk(): DiskSyncResult {
    if (!this.activeBuffer) {
      return { status: "no_open_file" };
    }

    let diskContent: string;
    try {
      diskContent = this.workspace.readFile(this.activeBuffer.path);
    } catch (err) {
      if (err instanceof WorkspaceError && err.code === "NotFound") {
        if (!computeIsDirty(this.activeBuffer)) {
          const deletedPath = this.activeBuffer.path;
          this.activeBuffer = null;
          return { status: "deleted", path: deletedPath };
        }
        this.activeBuffer.hasExternalConflict = true;
        return {
          status: "conflict",
          buffer: toSnapshot(this.activeBuffer),
          diskHash: null,
        };
      }
      throw err;
    }

    const currentDiskHash = hashContent(diskContent);
    if (currentDiskHash === this.activeBuffer.diskHash) {
      // If an external edit was reverted back to our base snapshot, clear any conflict.
      this.activeBuffer.hasExternalConflict = false;
      return {
        status: "unchanged",
        buffer: toSnapshot(this.activeBuffer),
      };
    }

    if (!computeIsDirty(this.activeBuffer)) {
      this.activeBuffer.canonicalPath = sandbox.resolveExisting(
        this.workspace.root,
        this.activeBuffer.path,
      );
      this.activeBuffer.content = diskContent;
      this.activeBuffer.contentHash = currentDiskHash;
      this.activeBuffer.diskHash = currentDiskHash;
      this.activeBuffer.hasExternalConflict = false;
      return {
        status: "reloaded",
        buffer: toSnapshot(this.activeBuffer),
      };
    }

    this.activeBuffer.hasExternalConflict = true;
    return {
      status: "conflict",
      buffer: toSnapshot(this.activeBuffer),
      diskHash: currentDiskHash,
    };
  }

  /** Lists all `.md` files under the workspace or an optional `subpath`. */
  listFiles(subpath?: string): string[] {
    return this.workspace.listFiles(subpath);
  }

  /**
   * Reads a `.md` file, returning the live in-memory buffer when `relPath`
   * resolves to the currently active file, or reading from disk otherwise.
   */
  readFile(relPath: string): ReadFileResult {
    const { normalized, resolved } = this.validatePathInSandbox(relPath);

    if (this.activeBuffer && this.matchesActive(normalized, resolved)) {
      return {
        path: normalized,
        content: this.activeBuffer.content,
        contentHash: this.activeBuffer.contentHash,
        isDirty: computeIsDirty(this.activeBuffer),
      };
    }

    const content = this.workspace.readFile(relPath);
    return {
      path: normalized,
      content,
      contentHash: hashContent(content),
      isDirty: false,
    };
  }

  /**
   * Computes the current SHA-256 hex digest of a `.md` file, reflecting the
   * live in-memory buffer when `relPath` is the currently active file.
   */
  hashFile(relPath: string): string {
    return this.readFile(relPath).contentHash;
  }

  /**
   * Performs a case-insensitive substring search across `.md` files, substituting
   * the live in-memory buffer for the currently open file.
   */
  searchFiles(query: string): SearchMatch[] {
    if (query.length === 0) {
      return [];
    }

    const needle = query.toLowerCase();
    const matches: SearchMatch[] = [];
    let matchedActive = false;

    for (const relPath of this.workspace.listFiles()) {
      let resolved: string;
      try {
        resolved = sandbox.resolveExisting(this.workspace.root, relPath);
      } catch (err) {
        if (err instanceof WorkspaceError && err.code === "NotFound") {
          continue;
        }
        throw err;
      }

      if (
        this.activeBuffer &&
        (resolved === this.activeBuffer.canonicalPath || relPath === this.activeBuffer.path)
      ) {
        matchedActive = true;
        matchContentLines(relPath, this.activeBuffer.content, needle, matches);
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(resolved);
      } catch (err) {
        if (getErrnoCode(err) === "ENOENT") {
          continue;
        }
        throw WorkspaceError.io(resolved, err);
      }

      // Skip non-UTF-8 files rather than aborting a workspace-wide search.
      let content: string;
      try {
        content = utf8Decoder.decode(bytes);
      } catch {
        continue;
      }

      matchContentLines(relPath, content, needle, matches);
    }

    // Include an externally-deleted open buffer that is still held in memory.
    if (this.activeBuffer && !matchedActive) {
      const extraMatches: SearchMatch[] = [];
      matchContentLines(this.activeBuffer.path, this.activeBuffer.content, needle, extraMatches);
      if (extraMatches.length > 0) {
        matches.push(...extraMatches);
        matches.sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line,
        );
      }
    }

    return matches;
  }

  /**
   * Stages a proposed edit to a `.md` file without writing to disk.
   *
   * Reads the current file content via `readFile(relPath)` (live unsaved buffer
   * if open, else disk) to compute `baseHash` and `diffLines`, and enforces at
   * most one active proposal per canonical file path by replacing any prior one.
   */
  proposeEdit(relPath: string, newContent: string, reason: string): PendingChange {
    const { normalized, resolved } = this.validatePathInSandbox(relPath);
    sandbox.ensureMarkdownPath(relPath, relPath);
    sandbox.ensureMarkdownPath(resolved, relPath);

    const current = this.readFile(relPath);
    const canonicalPath =
      this.activeBuffer && this.matchesActive(normalized, resolved)
        ? this.activeBuffer.canonicalPath
        : sandbox.resolveExisting(this.workspace.root, relPath);

    const existingId = this.proposalIdByCanonicalPath.get(canonicalPath);
    if (existingId !== undefined) {
      this.pendingProposals.delete(existingId);
    }

    const proposal: InternalProposal = {
      id: randomUUID(),
      path: current.path,
      canonicalPath,
      baseHash: current.contentHash,
      proposedContent: newContent,
      reason,
      diffLines: computeLineDiff(current.content, newContent),
      createdAt: new Date().toISOString(),
    };

    this.pendingProposals.set(proposal.id, proposal);
    this.proposalIdByCanonicalPath.set(canonicalPath, proposal.id);

    return toProposalSnapshot(proposal);
  }

  /**
   * Accepts a pending proposal by `id`, writing its `proposedContent` atomically
   * to disk and updating the active open buffer if that file is currently open.
   *
   * Unless `options.force` is `true`, verifies the current content hash (live
   * buffer if open, else disk) still matches `proposal.baseHash`. On mismatch,
   * keeps the proposal queued and returns `{ status: "conflict", ... }`.
   */
  acceptProposal(id: string, options?: AcceptProposalOptions): AcceptProposalResult {
    const proposal = this.pendingProposals.get(id);
    if (!proposal) {
      throw WorkspaceError.proposalNotFound(id);
    }

    const isActive = this.matchesProposalActive(proposal);
    const currentHash = isActive
      ? this.activeBuffer!.contentHash
      : this.readDiskHashOrNull(proposal.path);

    const force = options?.force === true;
    if (!force && currentHash !== proposal.baseHash) {
      return {
        status: "conflict",
        proposal: toProposalSnapshot(proposal),
        currentHash,
      };
    }

    this.workspace.saveFile(proposal.path, proposal.proposedContent);

    let openFile: OpenFileBuffer | null = null;
    if (this.activeBuffer && isActive) {
      const nextHash = hashContent(proposal.proposedContent);
      this.activeBuffer.canonicalPath = sandbox.resolveExisting(
        this.workspace.root,
        this.activeBuffer.path,
      );
      this.activeBuffer.content = proposal.proposedContent;
      this.activeBuffer.contentHash = nextHash;
      this.activeBuffer.diskHash = nextHash;
      this.activeBuffer.hasExternalConflict = false;
      openFile = toSnapshot(this.activeBuffer);
    }

    this.removeProposal(proposal);

    return {
      status: "accepted",
      id: proposal.id,
      path: proposal.path,
      openFile,
    };
  }

  /**
   * Rejects and removes a pending proposal by `id` without touching disk or
   * the active open file buffer.
   */
  rejectProposal(id: string): PendingChange {
    const proposal = this.pendingProposals.get(id);
    if (!proposal) {
      throw WorkspaceError.proposalNotFound(id);
    }

    this.removeProposal(proposal);
    return toProposalSnapshot(proposal);
  }

  /**
   * Attempts to accept every pending proposal with `force: false`, applying all
   * clean proposals and leaving conflicted ones intact in the queue.
   */
  acceptAllProposals(): AcceptAllProposalsResult {
    const accepted: AcceptedProposalResult[] = [];
    const conflicted: ConflictedProposalResult[] = [];

    for (const id of Array.from(this.pendingProposals.keys())) {
      const result = this.acceptProposal(id, { force: false });
      if (result.status === "accepted") {
        accepted.push(result);
      } else {
        conflicted.push(result);
      }
    }

    return { accepted, conflicted };
  }

  private validatePathInSandbox(relPath: string): { normalized: string; resolved: string } {
    const normalized = toForwardSlashRelative(relPath);
    const resolved = sandbox.resolveForWrite(this.workspace.root, relPath);
    return { normalized, resolved };
  }

  private matchesActive(normalized: string, resolved: string): boolean {
    if (!this.activeBuffer) {
      return false;
    }
    return normalized === this.activeBuffer.path || resolved === this.activeBuffer.canonicalPath;
  }

  private matchesProposalActive(proposal: InternalProposal): boolean {
    if (!this.activeBuffer) {
      return false;
    }
    return (
      proposal.path === this.activeBuffer.path ||
      proposal.canonicalPath === this.activeBuffer.canonicalPath
    );
  }

  private removeProposal(proposal: InternalProposal): void {
    this.pendingProposals.delete(proposal.id);
    if (this.proposalIdByCanonicalPath.get(proposal.canonicalPath) === proposal.id) {
      this.proposalIdByCanonicalPath.delete(proposal.canonicalPath);
    }
  }

  private readDiskHashOrNull(relPath: string): string | null {
    try {
      return hashContent(this.workspace.readFile(relPath));
    } catch (err) {
      if (err instanceof WorkspaceError && err.code === "NotFound") {
        return null;
      }
      throw err;
    }
  }
}
