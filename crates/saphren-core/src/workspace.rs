use std::collections::{BTreeSet, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::error::WorkspaceError;
use crate::sandbox;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A single line match returned by a case-insensitive workspace search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchMatch {
    /// Forward-slash path relative to the workspace root.
    pub path: String,
    /// 1-based line number of the matching line.
    pub line: usize,
    /// Contents of the matching line without trailing line endings.
    pub snippet: String,
}

/// A sandboxed local Markdown workspace rooted at a canonical directory.
#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    /// Opens a workspace at `root`, canonicalizing the path and verifying it is a directory.
    pub fn open(root: impl AsRef<Path>) -> Result<Self, WorkspaceError> {
        let input = root.as_ref();
        let canonical =
            fs::canonicalize(input).map_err(|err| WorkspaceError::InvalidWorkspaceRoot {
                path: input.to_path_buf(),
                reason: err.to_string(),
            })?;

        if !canonical.is_dir() {
            return Err(WorkspaceError::InvalidWorkspaceRoot {
                path: input.to_path_buf(),
                reason: "path is not a directory".to_owned(),
            });
        }

        Ok(Self { root: canonical })
    }

    /// Returns the canonical workspace root directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Lists all `.md` files under the workspace (or an optional `subpath`),
    /// returning sorted, forward-slash paths relative to `workspace_root`.
    pub fn list_files(&self, subpath: Option<&str>) -> Result<Vec<String>, WorkspaceError> {
        let start_dir = match subpath {
            None | Some("") | Some(".") => self.root.clone(),
            Some(sub) => {
                let resolved = sandbox::resolve_existing(&self.root, sub)?;
                if !resolved.is_dir() {
                    return Err(WorkspaceError::NotADirectory {
                        path: sub.to_owned(),
                    });
                }
                resolved
            }
        };

        let mut visited_dirs = HashSet::new();
        visited_dirs.insert(start_dir.clone());
        let mut files = BTreeSet::new();

        self.walk_markdown_files(&start_dir, &mut visited_dirs, &mut files)?;
        Ok(files.into_iter().collect())
    }

    /// Performs a case-insensitive substring search across all `.md` files in the workspace.
    pub fn search_files(&self, query: &str) -> Result<Vec<SearchMatch>, WorkspaceError> {
        if query.is_empty() {
            return Ok(Vec::new());
        }

        let needle = query.to_lowercase();
        let mut matches = Vec::new();

        for rel_path in self.list_files(None)? {
            let resolved = match sandbox::resolve_existing(&self.root, &rel_path) {
                Ok(path) => path,
                Err(WorkspaceError::NotFound { .. }) => continue,
                Err(err) => return Err(err),
            };

            let bytes = match fs::read(&resolved) {
                Ok(bytes) => bytes,
                Err(err) if err.kind() == ErrorKind::NotFound => continue,
                Err(source) => {
                    return Err(WorkspaceError::Io {
                        path: resolved,
                        source,
                    });
                }
            };

            // Skip non-UTF-8 files rather than aborting a workspace-wide search.
            let Ok(content) = String::from_utf8(bytes) else {
                continue;
            };

            for (idx, line) in content.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    matches.push(SearchMatch {
                        path: rel_path.clone(),
                        line: idx + 1,
                        snippet: line.to_owned(),
                    });
                }
            }
        }

        Ok(matches)
    }

    /// Reads a `.md` file from disk inside the workspace sandbox.
    pub fn read_file(&self, path: &str) -> Result<String, WorkspaceError> {
        let canonical = sandbox::resolve_existing(&self.root, path)?;
        if !canonical.is_file() {
            return Err(WorkspaceError::NotAFile {
                path: path.to_owned(),
            });
        }
        sandbox::ensure_markdown_path(Path::new(path), path)?;
        sandbox::ensure_markdown_path(&canonical, path)?;

        fs::read_to_string(&canonical).map_err(|source| WorkspaceError::Io {
            path: canonical,
            source,
        })
    }

    /// Atomically writes a `.md` file inside the workspace sandbox, creating
    /// missing parent directories within the workspace if needed.
    ///
    /// Intended for user-initiated saves and approved proposals only; MCP tools
    /// must never call this directly.
    pub fn save_file(&self, path: &str, content: &str) -> Result<(), WorkspaceError> {
        let target = sandbox::resolve_for_write(&self.root, path)?;
        if target.is_dir() {
            return Err(WorkspaceError::NotAFile {
                path: path.to_owned(),
            });
        }
        sandbox::ensure_markdown_path(Path::new(path), path)?;
        sandbox::ensure_markdown_path(&target, path)?;

        let parent = target.parent().ok_or_else(|| WorkspaceError::PathOutsideRoot {
            path: path.to_owned(),
        })?;

        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|source| WorkspaceError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }

        let canonical_parent = fs::canonicalize(parent).map_err(|source| WorkspaceError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
        if !canonical_parent.starts_with(&self.root) {
            return Err(WorkspaceError::PathOutsideRoot {
                path: path.to_owned(),
            });
        }

        let file_name = target.file_name().ok_or_else(|| WorkspaceError::NotAFile {
            path: path.to_owned(),
        })?;
        let final_path = canonical_parent.join(file_name);

        write_file_atomically(&canonical_parent, &final_path, content)
    }

    fn walk_markdown_files(
        &self,
        dir: &Path,
        visited_dirs: &mut HashSet<PathBuf>,
        files: &mut BTreeSet<String>,
    ) -> Result<(), WorkspaceError> {
        let entries = fs::read_dir(dir).map_err(|source| WorkspaceError::Io {
            path: dir.to_path_buf(),
            source,
        })?;

        for entry_res in entries {
            let entry = entry_res.map_err(|source| WorkspaceError::Io {
                path: dir.to_path_buf(),
                source,
            })?;

            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }

            let entry_path = entry.path();
            // Skip broken symlinks or entries that vanish mid-traversal.
            let Ok(canonical) = fs::canonicalize(&entry_path) else {
                continue;
            };

            // Never leak or traverse targets outside the workspace root.
            if !canonical.starts_with(&self.root) {
                continue;
            }

            if canonical.is_dir() {
                // Recurse on canonical path and track visited dirs to prevent symlink
                // cycles and keep yielded relative paths deterministic.
                if visited_dirs.insert(canonical.clone()) {
                    self.walk_markdown_files(&canonical, visited_dirs, files)?;
                }
            } else if canonical.is_file()
                && sandbox::is_markdown_path(&entry_path)
                && sandbox::is_markdown_path(&canonical)
                && let Some(rel) = sandbox::to_relative_string(&self.root, &entry_path)
            {
                files.insert(rel);
            }
        }

        Ok(())
    }
}

fn write_file_atomically(
    parent: &Path,
    target: &Path,
    content: &str,
) -> Result<(), WorkspaceError> {
    let pid = std::process::id();
    let (tmp_path, mut tmp_file) = loop {
        let seq = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        // Leading dot keeps temporary files invisible to `.md` listing and watchers.
        let candidate = parent.join(format!(".saphren-tmp-{pid}-{seq}"));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => break (candidate, file),
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(source) => {
                return Err(WorkspaceError::Io {
                    path: candidate,
                    source,
                });
            }
        }
    };

    if let Err(source) = tmp_file
        .write_all(content.as_bytes())
        .and_then(|()| tmp_file.flush())
    {
        drop(tmp_file);
        let _ = fs::remove_file(&tmp_path);
        return Err(WorkspaceError::Io {
            path: tmp_path,
            source,
        });
    }
    drop(tmp_file);

    if let Err(source) = fs::rename(&tmp_path, target) {
        let _ = fs::remove_file(&tmp_path);
        return Err(WorkspaceError::Io {
            path: target.to_path_buf(),
            source,
        });
    }

    Ok(())
}
