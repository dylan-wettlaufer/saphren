import * as fs from "node:fs";
import * as path from "node:path";
import { WorkspaceError } from "./error";
import * as sandbox from "./sandbox";

let tempFileCounter = 0;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** A single line match returned by a case-insensitive workspace search. */
export interface SearchMatch {
  /** Forward-slash path relative to the workspace root. */
  path: string;
  /** 1-based line number of the matching line. */
  line: number;
  /** Contents of the matching line without trailing line endings. */
  snippet: string;
}

function getErrnoCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const normalized = content.endsWith("\r\n")
    ? content.slice(0, -2)
    : content.endsWith("\n")
      ? content.slice(0, -1)
      : content;
  return normalized.split(/\r?\n/);
}

/** A sandboxed local Markdown workspace rooted at a canonical directory. */
export class Workspace {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  /** Opens a workspace at `rootPath`, canonicalizing it and verifying it is a directory. */
  static open(rootPath: string): Workspace {
    let canonical: string;
    try {
      canonical = fs.realpathSync(rootPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw WorkspaceError.invalidWorkspaceRoot(rootPath, reason);
    }

    try {
      if (!fs.statSync(canonical).isDirectory()) {
        throw WorkspaceError.invalidWorkspaceRoot(rootPath, "path is not a directory");
      }
    } catch (err) {
      if (err instanceof WorkspaceError) {
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw WorkspaceError.invalidWorkspaceRoot(rootPath, reason);
    }

    return new Workspace(canonical);
  }

  /**
   * Lists all `.md` files under the workspace (or an optional `subpath`),
   * returning sorted, forward-slash paths relative to `root`.
   */
  listFiles(subpath?: string): string[] {
    let startDir: string;
    if (!subpath || subpath === ".") {
      startDir = this.root;
    } else {
      const resolved = sandbox.resolveExisting(this.root, subpath);
      if (!fs.statSync(resolved).isDirectory()) {
        throw WorkspaceError.notADirectory(subpath);
      }
      startDir = resolved;
    }

    const visitedDirs = new Set<string>([startDir]);
    const files = new Set<string>();
    this.walkMarkdownFiles(startDir, visitedDirs, files);

    return Array.from(files).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** Performs a case-insensitive substring search across all `.md` files in the workspace. */
  searchFiles(query: string): SearchMatch[] {
    if (query.length === 0) {
      return [];
    }

    const needle = query.toLowerCase();
    const matches: SearchMatch[] = [];

    for (const relPath of this.listFiles()) {
      let resolved: string;
      try {
        resolved = sandbox.resolveExisting(this.root, relPath);
      } catch (err) {
        if (err instanceof WorkspaceError && err.code === "NotFound") {
          continue;
        }
        throw err;
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

      const lines = splitLines(content);
      for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx]!;
        if (line.toLowerCase().includes(needle)) {
          matches.push({
            path: relPath,
            line: idx + 1,
            snippet: line,
          });
        }
      }
    }

    return matches;
  }

  /** Reads a `.md` file from disk inside the workspace sandbox. */
  readFile(relPath: string): string {
    const canonical = sandbox.resolveExisting(this.root, relPath);
    if (!fs.statSync(canonical).isFile()) {
      throw WorkspaceError.notAFile(relPath);
    }
    sandbox.ensureMarkdownPath(relPath, relPath);
    sandbox.ensureMarkdownPath(canonical, relPath);

    try {
      return fs.readFileSync(canonical, "utf8");
    } catch (err) {
      throw WorkspaceError.io(canonical, err);
    }
  }

  /**
   * Atomically writes a `.md` file inside the workspace sandbox, creating
   * missing parent directories within the workspace if needed.
   *
   * Intended for user-initiated saves and approved proposals only; MCP tools
   * must never call this directly.
   */
  saveFile(relPath: string, content: string): void {
    const target = sandbox.resolveForWrite(this.root, relPath);
    try {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        throw WorkspaceError.notAFile(relPath);
      }
    } catch (err) {
      if (err instanceof WorkspaceError) {
        throw err;
      }
      throw WorkspaceError.io(target, err);
    }

    sandbox.ensureMarkdownPath(relPath, relPath);
    sandbox.ensureMarkdownPath(target, relPath);

    const parent = path.dirname(target);
    if (!parent || parent === target) {
      throw WorkspaceError.pathOutsideRoot(relPath);
    }

    if (!fs.existsSync(parent)) {
      try {
        fs.mkdirSync(parent, { recursive: true });
      } catch (err) {
        throw WorkspaceError.io(parent, err);
      }
    }

    let canonicalParent: string;
    try {
      canonicalParent = fs.realpathSync(parent);
    } catch (err) {
      throw WorkspaceError.io(parent, err);
    }
    if (!sandbox.isInsideRoot(this.root, canonicalParent)) {
      throw WorkspaceError.pathOutsideRoot(relPath);
    }

    const fileName = path.basename(target);
    if (!fileName) {
      throw WorkspaceError.notAFile(relPath);
    }
    const finalPath = path.join(canonicalParent, fileName);

    writeFileAtomically(canonicalParent, finalPath, content);
  }

  private walkMarkdownFiles(
    dir: string,
    visitedDirs: Set<string>,
    files: Set<string>,
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw WorkspaceError.io(dir, err);
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const entryPath = path.join(dir, entry.name);
      // Skip broken symlinks or entries that vanish mid-traversal.
      let canonical: string;
      try {
        canonical = fs.realpathSync(entryPath);
      } catch {
        continue;
      }

      // Never leak or traverse targets outside the workspace root.
      if (!sandbox.isInsideRoot(this.root, canonical)) {
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(canonical);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        // Recurse on canonical path and track visited dirs to prevent symlink
        // cycles and keep yielded relative paths deterministic.
        if (!visitedDirs.has(canonical)) {
          visitedDirs.add(canonical);
          this.walkMarkdownFiles(canonical, visitedDirs, files);
        }
      } else if (
        stat.isFile() &&
        sandbox.isMarkdownPath(entryPath) &&
        sandbox.isMarkdownPath(canonical)
      ) {
        const rel = sandbox.toRelativeString(this.root, entryPath);
        if (rel !== null) {
          files.add(rel);
        }
      }
    }
  }
}

function writeFileAtomically(parent: string, target: string, content: string): void {
  const pid = process.pid;
  let tmpPath: string;
  let fd: number;

  for (;;) {
    const seq = tempFileCounter;
    tempFileCounter += 1;
    // Leading dot keeps temporary files invisible to `.md` listing and watchers.
    const candidate = path.join(parent, `.saphren-tmp-${pid}-${seq}`);
    try {
      fd = fs.openSync(candidate, "wx");
      tmpPath = candidate;
      break;
    } catch (err) {
      if (getErrnoCode(err) === "EEXIST") {
        continue;
      }
      throw WorkspaceError.io(candidate, err);
    }
  }

  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors while cleaning up.
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw WorkspaceError.io(tmpPath, err);
  }

  try {
    fs.closeSync(fd);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw WorkspaceError.io(tmpPath, err);
  }

  try {
    fs.renameSync(tmpPath, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw WorkspaceError.io(target, err);
  }
}
