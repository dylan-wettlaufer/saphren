import * as fs from "node:fs";
import * as path from "node:path";
import { WorkspaceError } from "./error";

const MAX_SYMLINK_HOPS = 16;

function getErrnoCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Returns true if `target` is equal to `root` or strictly nested inside `root`. */
export function isInsideRoot(root: string, target: string): boolean {
  if (target === root) {
    return true;
  }
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(prefix);
}

/**
 * Lexically normalizes a workspace-relative path, rejecting absolute paths and
 * any `..` traversal that would ascend above the workspace root.
 */
export function normalizeRelative(relPath: string): string {
  if (
    path.isAbsolute(relPath) ||
    relPath.startsWith("/") ||
    relPath.startsWith("\\") ||
    /^[A-Za-z]:/.test(relPath)
  ) {
    throw WorkspaceError.pathOutsideRoot(relPath);
  }

  const stack: string[] = [];
  for (const segment of relPath.split(/[\\/]/)) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (stack.length === 0) {
        throw WorkspaceError.pathOutsideRoot(relPath);
      }
      stack.pop();
    } else {
      stack.push(segment);
    }
  }

  return stack.join(path.sep);
}

/**
 * Resolves an existing path relative to `root`, canonicalizing it and verifying
 * it remains inside `root`.
 */
export function resolveExisting(root: string, relPath: string): string {
  const normalized = normalizeRelative(relPath);
  const candidate = normalized ? path.join(root, normalized) : root;

  try {
    const canonical = fs.realpathSync(candidate);
    if (!isInsideRoot(root, canonical)) {
      throw WorkspaceError.pathOutsideRoot(relPath);
    }
    return canonical;
  } catch (err) {
    if (err instanceof WorkspaceError) {
      throw err;
    }
    const code = getErrnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      // Verify no intermediate or dangling symlink escapes `root` before
      // reporting NotFound/NotADirectory, preventing escape probes.
      verifyAncestorsWithinRoot(root, candidate, relPath);
      if (code === "ENOTDIR") {
        throw WorkspaceError.notADirectory(relPath);
      }
      throw WorkspaceError.notFound(relPath);
    }
    throw WorkspaceError.io(candidate, err);
  }
}

/**
 * Resolves a target path for writing (which may not exist yet), ensuring the
 * target and its existing ancestors stay inside `root` and no symlink escapes.
 */
export function resolveForWrite(root: string, relPath: string): string {
  const normalized = normalizeRelative(relPath);
  const candidate = normalized ? path.join(root, normalized) : root;

  try {
    const canonical = fs.realpathSync(candidate);
    if (!isInsideRoot(root, canonical)) {
      throw WorkspaceError.pathOutsideRoot(relPath);
    }
    return canonical;
  } catch (err) {
    if (err instanceof WorkspaceError) {
      throw err;
    }
    const code = getErrnoCode(err);
    if (code === "ENOENT") {
      const { canonicalAncestor, tail } = verifyAncestorsWithinRoot(root, candidate, relPath);
      return path.join(canonicalAncestor, ...tail.reverse());
    }
    if (code === "ENOTDIR") {
      verifyAncestorsWithinRoot(root, candidate, relPath);
      throw WorkspaceError.notADirectory(relPath);
    }
    throw WorkspaceError.io(candidate, err);
  }
}

function verifyAncestorsWithinRoot(
  root: string,
  candidate: string,
  originalRel: string,
): { canonicalAncestor: string; tail: string[] } {
  let current = candidate;
  const tail: string[] = [];

  for (;;) {
    try {
      const canonical = fs.realpathSync(current);
      if (!isInsideRoot(root, canonical)) {
        throw WorkspaceError.pathOutsideRoot(originalRel);
      }
      return { canonicalAncestor: canonical, tail };
    } catch (err) {
      if (err instanceof WorkspaceError) {
        throw err;
      }
      const code = getErrnoCode(err);
      if (code === "ENOENT" || code === "ENOTDIR") {
        try {
          const stat = fs.lstatSync(current);
          if (stat.isSymbolicLink() && danglingSymlinkEscapesRoot(root, current)) {
            throw WorkspaceError.pathOutsideRoot(originalRel);
          }
        } catch (lstatErr) {
          if (lstatErr instanceof WorkspaceError) {
            throw lstatErr;
          }
        }

        const parent = path.dirname(current);
        if (parent === current) {
          throw WorkspaceError.pathOutsideRoot(originalRel);
        }
        tail.push(path.basename(current));
        current = parent;
        continue;
      }
      throw WorkspaceError.io(current, err);
    }
  }
}

function canonicalizeBestEffort(targetPath: string): string | null {
  let cur = targetPath;
  const suffix: string[] = [];

  for (;;) {
    try {
      const canon = fs.realpathSync(cur);
      return suffix.length === 0 ? canon : path.join(canon, ...suffix.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) {
        return null;
      }
      suffix.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Follows a dangling symlink chain (up to `MAX_SYMLINK_HOPS`) to verify whether
 * its target escapes `root`. Returns `true` on escape, cycle, or unreadable link.
 */
function danglingSymlinkEscapesRoot(root: string, linkPath: string): boolean {
  let current = linkPath;

  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
    let target: string;
    try {
      target = fs.readlinkSync(current);
    } catch {
      return true;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return true;
    }
    const canonicalParent = canonicalizeBestEffort(parent);
    if (!canonicalParent || !isInsideRoot(root, canonicalParent)) {
      return true;
    }

    const joined = path.isAbsolute(target) ? target : path.join(canonicalParent, target);
    const normalized = path.normalize(joined);
    const resolved = canonicalizeBestEffort(normalized);
    if (!resolved || !isInsideRoot(root, resolved)) {
      return true;
    }

    try {
      const stat = fs.lstatSync(resolved);
      if (stat.isSymbolicLink()) {
        current = resolved;
        continue;
      }
      try {
        return !isInsideRoot(root, fs.realpathSync(resolved));
      } catch {
        return true;
      }
    } catch (err) {
      if (getErrnoCode(err) === "ENOENT") {
        return false;
      }
      return true;
    }
  }

  return true;
}

/** Returns `true` if `filePath` has a `.md` extension (case-insensitive). */
export function isMarkdownPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".md";
}

/** Validates that `filePath` has a `.md` extension, throwing `UnsupportedFileType` otherwise. */
export function ensureMarkdownPath(filePath: string, originalRel: string): void {
  if (!isMarkdownPath(filePath)) {
    throw WorkspaceError.unsupportedFileType(originalRel);
  }
}

/** Formats a path inside `root` as a forward-slash workspace-relative string. */
export function toRelativeString(root: string, targetPath: string): string | null {
  if (!isInsideRoot(root, targetPath)) {
    return null;
  }
  const rel = path.relative(root, targetPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join("/");
}
