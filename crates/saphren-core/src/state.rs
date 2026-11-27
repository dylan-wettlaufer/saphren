use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::WorkspaceError;
use crate::hash::sha256_hex;
use crate::proposal::{PendingChange, ProposalId};
use crate::sandbox;
use crate::workspace::Workspace;

/// In-memory state of the currently open Markdown file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenFileBuffer {
    /// Forward-slash path relative to the workspace root.
    pub path: String,
    /// Live editor text, including any unsaved edits.
    pub content: String,
    /// Hex-encoded SHA-256 hash of the file content last read from or saved to disk.
    pub disk_hash: String,
    /// Whether `content` diverges from the last known disk state (`disk_hash`).
    pub is_dirty: bool,
}

impl OpenFileBuffer {
    /// Computes the SHA-256 hex digest of the current in-memory buffer text.
    pub fn content_hash(&self) -> String {
        sha256_hex(&self.content)
    }
}

/// File contents returned by [`WorkspaceState::read_file`], sourced from the
/// live in-memory buffer when the file is currently open or from disk otherwise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileContent {
    /// Forward-slash path relative to the workspace root.
    pub path: String,
    /// Current file text (live unsaved buffer if open, otherwise disk content).
    pub content: String,
    /// Whether the returned content has unsaved edits in the active buffer.
    pub is_dirty: bool,
}

/// Authoritative in-memory state for an open Saphren workspace.
///
/// Tracks the canonical workspace root, the single active editor buffer, and
/// pending agent edit proposals.
#[derive(Debug, Clone, Default)]
pub struct WorkspaceState {
    root: Option<PathBuf>,
    open_file: Option<OpenFileBuffer>,
    proposals: HashMap<ProposalId, PendingChange>,
}

impl WorkspaceState {
    /// Creates an empty state with no workspace open.
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the canonical workspace root if a workspace is currently open.
    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    /// Returns the currently open editor buffer, if any.
    pub fn active_file(&self) -> Option<&OpenFileBuffer> {
        self.open_file.as_ref()
    }

    /// Returns all currently pending agent edit proposals keyed by [`ProposalId`].
    pub fn proposals(&self) -> &HashMap<ProposalId, PendingChange> {
        &self.proposals
    }

    /// Looks up a pending proposal by its [`ProposalId`].
    pub fn proposal(&self, id: &str) -> Option<&PendingChange> {
        self.proposals.get(id)
    }

    /// Looks up a pending proposal targeting `path` (normalized relative to workspace root).
    pub fn proposal_for_path(&self, path: &str) -> Option<&PendingChange> {
        let normalized = sandbox::normalize_relative_string(path).ok()?;
        self.proposals
            .values()
            .find(|proposal| proposal.path == normalized)
    }

    /// Opens a workspace at `root`, canonicalizing and validating the directory.
    ///
    /// Clears any previously open file buffer and pending proposals only after
    /// the new workspace root is validated.
    pub fn open_workspace(&mut self, root: impl AsRef<Path>) -> Result<&Path, WorkspaceError> {
        let workspace = Workspace::open(root)?;
        self.root = Some(workspace.root().to_path_buf());
        self.open_file = None;
        self.proposals.clear();
        Ok(self.root.as_deref().expect("root was just set"))
    }

    /// Closes the current workspace, clearing the active file buffer and all pending proposals.
    pub fn close_workspace(&mut self) {
        self.root = None;
        self.open_file = None;
        self.proposals.clear();
    }

    /// Lists all `.md` files under the open workspace (or an optional `subpath`).
    pub fn list_files(&self, subpath: Option<&str>) -> Result<Vec<String>, WorkspaceError> {
        self.require_workspace()?.list_files(subpath)
    }

    /// Opens a `.md` file from disk into the active buffer in the `Clean` state.
    ///
    /// Leaves the previously open buffer untouched if reading or validation fails.
    pub fn open_file(&mut self, path: &str) -> Result<&OpenFileBuffer, WorkspaceError> {
        let workspace = self.require_workspace()?;
        let content = workspace.read_file(path)?;
        let rel_path = sandbox::normalize_relative_string(path)?;
        let disk_hash = sha256_hex(&content);

        Ok(self.open_file.insert(OpenFileBuffer {
            path: rel_path,
            content,
            disk_hash,
            is_dirty: false,
        }))
    }

    /// Closes the active file buffer without writing unsaved changes to disk.
    pub fn close_file(&mut self) {
        self.open_file = None;
    }

    /// Syncs live editor text for the active file, updating `is_dirty` against `disk_hash`.
    ///
    /// Transitions `Clean -> Dirty` when content diverges from `disk_hash`, and
    /// back to `Clean` if edits are reverted to match `disk_hash`.
    pub fn update_buffer(
        &mut self,
        path: &str,
        content: impl Into<String>,
    ) -> Result<&OpenFileBuffer, WorkspaceError> {
        if self.root.is_none() {
            return Err(WorkspaceError::NoWorkspaceOpen);
        }

        let rel_path = sandbox::normalize_relative_string(path)?;
        let buffer = self.open_file.as_mut().ok_or(WorkspaceError::NoActiveFile)?;
        if buffer.path != rel_path {
            return Err(WorkspaceError::ActiveFileMismatch {
                active: buffer.path.clone(),
                requested: path.to_owned(),
            });
        }

        buffer.content = content.into();
        buffer.is_dirty = sha256_hex(&buffer.content) != buffer.disk_hash;
        Ok(buffer)
    }

    /// Atomically saves the active buffer to disk, transitioning `Dirty -> Clean`
    /// and updating `disk_hash`.
    ///
    /// Preserves the existing `is_dirty` and `disk_hash` state if the disk write fails.
    pub fn save_active_file(&mut self) -> Result<&OpenFileBuffer, WorkspaceError> {
        let root = self.root.as_ref().ok_or(WorkspaceError::NoWorkspaceOpen)?;
        let workspace = Workspace::from_canonical_root(root.clone());
        let buffer = self.open_file.as_mut().ok_or(WorkspaceError::NoActiveFile)?;

        workspace.save_file(&buffer.path, &buffer.content)?;
        buffer.disk_hash = sha256_hex(&buffer.content);
        buffer.is_dirty = false;
        Ok(buffer)
    }

    /// Reads a `.md` file from the live active buffer when open, or from disk otherwise.
    pub fn read_file(&self, path: &str) -> Result<FileContent, WorkspaceError> {
        let workspace = self.require_workspace()?;
        let rel_path = sandbox::normalize_relative_string(path)?;

        // Always validate the path against the sandbox so escaping symlinks are
        // rejected even before checking the active buffer.
        let canonical = match sandbox::resolve_existing(workspace.root(), path) {
            Ok(p) => Some(p),
            Err(WorkspaceError::NotFound { .. }) => None,
            Err(err) => return Err(err),
        };

        if let Some(buffer) = &self.open_file {
            let same_path = buffer.path == rel_path;
            let same_canonical = !same_path
                && canonical.is_some()
                && sandbox::resolve_existing(workspace.root(), &buffer.path).ok() == canonical;

            if same_path || same_canonical {
                return Ok(FileContent {
                    path: rel_path,
                    content: buffer.content.clone(),
                    is_dirty: buffer.is_dirty,
                });
            }
        }

        let content = workspace.read_file(path)?;
        Ok(FileContent {
            path: rel_path,
            content,
            is_dirty: false,
        })
    }

    fn require_workspace(&self) -> Result<Workspace, WorkspaceError> {
        let root = self.root.as_ref().ok_or(WorkspaceError::NoWorkspaceOpen)?;
        Ok(Workspace::from_canonical_root(root.clone()))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;
    use crate::proposal::DiffLine;

    fn assert_send_sync<T: Send + Sync>() {}

    fn sample_proposal(id: &str, path: &str) -> PendingChange {
        PendingChange {
            id: id.to_owned(),
            path: path.to_owned(),
            base_hash: sha256_hex("original"),
            proposed_content: "updated".to_owned(),
            reason: "refine wording".to_owned(),
            diff_lines: vec![
                DiffLine::Removed("original".to_owned()),
                DiffLine::Added("updated".to_owned()),
            ],
            created_at: "2026-11-27T17:00:00Z".to_owned(),
        }
    }

    #[test]
    fn workspace_state_is_send_and_sync() {
        assert_send_sync::<WorkspaceState>();
        assert_send_sync::<OpenFileBuffer>();
        assert_send_sync::<PendingChange>();
    }

    #[test]
    fn proposals_tracking_and_reset_on_workspace_change() {
        let dir_a = TempDir::new().unwrap();
        let dir_b = TempDir::new().unwrap();
        fs::write(dir_a.path().join("notes.md"), "original").unwrap();

        let mut state = WorkspaceState::new();
        state.open_workspace(dir_a.path()).unwrap();
        state.open_file("notes.md").unwrap();
        assert!(state.proposals().is_empty());

        let proposal = sample_proposal("prop-1", "notes.md");
        state.proposals.insert(proposal.id.clone(), proposal.clone());

        assert_eq!(state.proposals().len(), 1);
        assert_eq!(state.proposal("prop-1"), Some(&proposal));
        assert_eq!(state.proposal("missing"), None);
        assert_eq!(state.proposal_for_path("notes.md"), Some(&proposal));
        assert_eq!(state.proposal_for_path("./notes.md"), Some(&proposal));
        assert_eq!(state.proposal_for_path("../outside.md"), None);
        assert_eq!(state.proposal_for_path("other.md"), None);

        // Failed workspace switch must not clear active buffer or proposals.
        assert!(matches!(
            state.open_workspace(dir_a.path().join("does-not-exist")),
            Err(WorkspaceError::InvalidWorkspaceRoot { .. })
        ));
        assert!(state.active_file().is_some());
        assert_eq!(state.proposals().len(), 1);

        // Switching to a valid workspace clears active buffer and proposals.
        state.open_workspace(dir_b.path()).unwrap();
        assert_eq!(state.root(), Some(fs::canonicalize(dir_b.path()).unwrap().as_path()));
        assert!(state.active_file().is_none());
        assert!(state.proposals().is_empty());

        // Closing clears everything.
        state.proposals.insert(proposal.id.clone(), proposal);
        state.close_workspace();
        assert!(state.root().is_none());
        assert!(state.active_file().is_none());
        assert!(state.proposals().is_empty());
    }
}
