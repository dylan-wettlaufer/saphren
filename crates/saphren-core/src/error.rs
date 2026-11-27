use std::path::PathBuf;

/// Errors returned by sandboxed workspace operations.
#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    /// A path attempted to escape the workspace root (traversal, absolute path, or symlink).
    #[error("path escapes workspace root: {path}")]
    PathOutsideRoot { path: String },

    /// The workspace root path does not exist, cannot be canonicalized, or is not a directory.
    #[error("invalid workspace root '{}': {reason}", path.display())]
    InvalidWorkspaceRoot { path: PathBuf, reason: String },

    /// The requested file does not have a supported `.md` extension.
    #[error("unsupported file type (expected .md): {path}")]
    UnsupportedFileType { path: String },

    /// The requested file or directory does not exist inside the workspace.
    #[error("path not found: {path}")]
    NotFound { path: String },

    /// Expected a directory but found a non-directory entry.
    #[error("path is not a directory: {path}")]
    NotADirectory { path: String },

    /// Expected a file but found a directory or non-file entry.
    #[error("path is not a file: {path}")]
    NotAFile { path: String },

    /// An underlying filesystem I/O error.
    #[error("i/o error at '{}': {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}
