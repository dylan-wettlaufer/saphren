//! Headless domain crate for Saphren.
//!
//! Contains workspace sandboxing, file I/O, watching, diffing, and proposal state.
//! Zero UI or Tauri dependencies.

mod error;
mod hash;
mod proposal;
mod sandbox;
mod state;
mod workspace;

pub use error::WorkspaceError;
pub use hash::sha256_hex;
pub use proposal::{DiffLine, PendingChange, ProposalId};
pub use state::{FileContent, OpenFileBuffer, WorkspaceState};
pub use workspace::{SearchMatch, Workspace};

/// Crate version of `saphren-core`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_version_is_non_empty() {
        assert!(!VERSION.is_empty());
    }
}
