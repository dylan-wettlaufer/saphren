//! Headless domain crate for Saphren.
//!
//! Contains workspace sandboxing, file I/O, watching, diffing, and proposal state.
//! Zero UI or Tauri dependencies.

mod error;
mod sandbox;
mod workspace;

pub use error::WorkspaceError;
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
