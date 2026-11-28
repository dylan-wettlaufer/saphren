import * as fs from "node:fs";
import * as path from "node:path";
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

interface InternalBuffer {
  path: string;
  canonicalPath: string;
  content: string;
  contentHash: string;
  diskHash: string;
  hasExternalConflict: boolean;
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

/**
 * Stateful workspace controller owning the active in-memory file buffer on top
 * of a sandboxed `Workspace`.
 */
export class WorkspaceState {
  readonly workspace: Workspace;
  private activeBuffer: InternalBuffer | null = null;

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
