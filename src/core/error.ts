/** Discriminated error codes returned by sandboxed workspace operations. */
export type WorkspaceErrorCode =
  | "PathOutsideRoot"
  | "InvalidWorkspaceRoot"
  | "UnsupportedFileType"
  | "NotFound"
  | "NotADirectory"
  | "NotAFile"
  | "NoOpenFile"
  | "ActiveFileMismatch"
  | "UnsavedChanges"
  | "Io";

/** Error thrown by sandboxed workspace operations in `src/core`. */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly path: string;
  readonly reason?: string;

  constructor(
    code: WorkspaceErrorCode,
    path: string,
    message: string,
    options?: { reason?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WorkspaceError";
    this.code = code;
    this.path = path;
    this.reason = options?.reason;
  }

  static pathOutsideRoot(targetPath: string): WorkspaceError {
    return new WorkspaceError(
      "PathOutsideRoot",
      targetPath,
      `path escapes workspace root: ${targetPath}`,
    );
  }

  static invalidWorkspaceRoot(targetPath: string, reason: string): WorkspaceError {
    return new WorkspaceError(
      "InvalidWorkspaceRoot",
      targetPath,
      `invalid workspace root '${targetPath}': ${reason}`,
      { reason },
    );
  }

  static unsupportedFileType(targetPath: string): WorkspaceError {
    return new WorkspaceError(
      "UnsupportedFileType",
      targetPath,
      `unsupported file type (expected .md): ${targetPath}`,
    );
  }

  static notFound(targetPath: string): WorkspaceError {
    return new WorkspaceError("NotFound", targetPath, `path not found: ${targetPath}`);
  }

  static notADirectory(targetPath: string): WorkspaceError {
    return new WorkspaceError(
      "NotADirectory",
      targetPath,
      `path is not a directory: ${targetPath}`,
    );
  }

  static notAFile(targetPath: string): WorkspaceError {
    return new WorkspaceError("NotAFile", targetPath, `path is not a file: ${targetPath}`);
  }

  static noOpenFile(): WorkspaceError {
    return new WorkspaceError("NoOpenFile", "", "no file is currently open");
  }

  static activeFileMismatch(targetPath: string, activePath: string): WorkspaceError {
    return new WorkspaceError(
      "ActiveFileMismatch",
      targetPath,
      `path '${targetPath}' does not match active open file '${activePath}'`,
    );
  }

  static unsavedChanges(activePath: string): WorkspaceError {
    return new WorkspaceError(
      "UnsavedChanges",
      activePath,
      `active file '${activePath}' has unsaved changes`,
    );
  }

  static io(targetPath: string, cause: unknown): WorkspaceError {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new WorkspaceError("Io", targetPath, `i/o error at '${targetPath}': ${detail}`, {
      cause,
    });
  }
}
