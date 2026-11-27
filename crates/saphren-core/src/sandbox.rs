use std::ffi::OsString;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use crate::error::WorkspaceError;

const MAX_SYMLINK_HOPS: usize = 16;

/// Lexically normalizes a workspace-relative path, rejecting absolute paths and
/// any `..` traversal that would ascend above the workspace root.
pub(crate) fn normalize_relative(rel_path: &str) -> Result<PathBuf, WorkspaceError> {
    let path = Path::new(rel_path);
    let mut stack: Vec<OsString> = Vec::new();

    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => {
                return Err(WorkspaceError::PathOutsideRoot {
                    path: rel_path.to_owned(),
                });
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if stack.pop().is_none() {
                    return Err(WorkspaceError::PathOutsideRoot {
                        path: rel_path.to_owned(),
                    });
                }
            }
            Component::Normal(seg) => stack.push(seg.to_os_string()),
        }
    }

    let mut normalized = PathBuf::new();
    for seg in stack {
        normalized.push(seg);
    }
    Ok(normalized)
}

/// Resolves an existing path relative to `root`, canonicalizing it and verifying
/// it remains inside `root`.
pub(crate) fn resolve_existing(root: &Path, rel_path: &str) -> Result<PathBuf, WorkspaceError> {
    let normalized = normalize_relative(rel_path)?;
    let candidate = root.join(&normalized);

    match fs::canonicalize(&candidate) {
        Ok(canonical) => {
            if canonical.starts_with(root) {
                Ok(canonical)
            } else {
                Err(WorkspaceError::PathOutsideRoot {
                    path: rel_path.to_owned(),
                })
            }
        }
        Err(err) if matches!(err.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            // Verify no intermediate symlink or dangling symlink escapes `root`
            // before reporting NotFound/NotADirectory, preventing escape probes.
            verify_ancestors_within_root(root, &candidate, rel_path)?;
            if err.kind() == ErrorKind::NotADirectory {
                Err(WorkspaceError::NotADirectory {
                    path: rel_path.to_owned(),
                })
            } else {
                Err(WorkspaceError::NotFound {
                    path: rel_path.to_owned(),
                })
            }
        }
        Err(source) => Err(WorkspaceError::Io {
            path: candidate,
            source,
        }),
    }
}

/// Resolves a target path for writing (which may not exist yet), ensuring the
/// target and its existing ancestors stay inside `root` and no symlink escapes.
pub(crate) fn resolve_for_write(root: &Path, rel_path: &str) -> Result<PathBuf, WorkspaceError> {
    let normalized = normalize_relative(rel_path)?;
    let candidate = root.join(&normalized);

    match fs::canonicalize(&candidate) {
        Ok(canonical) => {
            if canonical.starts_with(root) {
                Ok(canonical)
            } else {
                Err(WorkspaceError::PathOutsideRoot {
                    path: rel_path.to_owned(),
                })
            }
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            let (canonical_ancestor, tail) =
                verify_ancestors_within_root(root, &candidate, rel_path)?;
            let mut resolved = canonical_ancestor;
            for seg in tail.into_iter().rev() {
                resolved.push(seg);
            }
            Ok(resolved)
        }
        Err(err) if err.kind() == ErrorKind::NotADirectory => {
            verify_ancestors_within_root(root, &candidate, rel_path)?;
            Err(WorkspaceError::NotADirectory {
                path: rel_path.to_owned(),
            })
        }
        Err(source) => Err(WorkspaceError::Io {
            path: candidate,
            source,
        }),
    }
}

/// Walks up from `candidate` to its deepest canonicalizable ancestor, checking
/// for dangling symlinks along the way and asserting the ancestor starts with `root`.
/// Returns `(canonical_ancestor, reversed_nonexistent_segments)`.
fn verify_ancestors_within_root(
    root: &Path,
    candidate: &Path,
    original_rel: &str,
) -> Result<(PathBuf, Vec<OsString>), WorkspaceError> {
    let mut current = candidate.to_path_buf();
    let mut tail = Vec::new();

    loop {
        match fs::canonicalize(&current) {
            Ok(canonical) => {
                if !canonical.starts_with(root) {
                    return Err(WorkspaceError::PathOutsideRoot {
                        path: original_rel.to_owned(),
                    });
                }
                return Ok((canonical, tail));
            }
            Err(err) if matches!(err.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
                if let Ok(meta) = fs::symlink_metadata(&current)
                    && meta.file_type().is_symlink()
                    && dangling_symlink_escapes_root(root, &current)
                {
                    return Err(WorkspaceError::PathOutsideRoot {
                        path: original_rel.to_owned(),
                    });
                }

                let Some(file_name) = current.file_name() else {
                    return Err(WorkspaceError::PathOutsideRoot {
                        path: original_rel.to_owned(),
                    });
                };
                tail.push(file_name.to_os_string());

                let Some(parent) = current.parent() else {
                    return Err(WorkspaceError::PathOutsideRoot {
                        path: original_rel.to_owned(),
                    });
                };
                current = parent.to_path_buf();
            }
            Err(source) => {
                return Err(WorkspaceError::Io {
                    path: current,
                    source,
                });
            }
        }
    }
}

fn normalize_absolute(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(seg) => out.push(seg),
        }
    }
    out
}

fn canonicalize_best_effort(path: &Path) -> Option<PathBuf> {
    let mut cur = path.to_path_buf();
    let mut suffix = Vec::new();

    loop {
        if let Ok(canon) = fs::canonicalize(&cur) {
            let mut result = canon;
            for seg in suffix.into_iter().rev() {
                result.push(seg);
            }
            return Some(result);
        }
        let seg = cur.file_name()?.to_os_string();
        suffix.push(seg);
        cur = cur.parent()?.to_path_buf();
    }
}

/// Follows a dangling symlink chain (up to `MAX_SYMLINK_HOPS`) to verify whether
/// its target escapes `root`. Returns `true` on escape, cycle, or unreadable link.
fn dangling_symlink_escapes_root(root: &Path, link_path: &Path) -> bool {
    let mut current = link_path.to_path_buf();

    for _ in 0..MAX_SYMLINK_HOPS {
        let Ok(target) = fs::read_link(&current) else {
            return true;
        };

        let Some(parent) = current.parent() else {
            return true;
        };
        let Some(canonical_parent) = canonicalize_best_effort(parent) else {
            return true;
        };
        if !canonical_parent.starts_with(root) {
            return true;
        }

        let joined = if target.is_absolute() {
            target
        } else {
            canonical_parent.join(target)
        };
        let normalized = normalize_absolute(&joined);
        let Some(resolved) = canonicalize_best_effort(&normalized) else {
            return true;
        };
        if !resolved.starts_with(root) {
            return true;
        }

        match fs::symlink_metadata(&resolved) {
            Ok(meta) if meta.file_type().is_symlink() => {
                current = resolved;
            }
            Ok(_) => {
                return !fs::canonicalize(&resolved).is_ok_and(|c| c.starts_with(root));
            }
            Err(err) if err.kind() == ErrorKind::NotFound => return false,
            Err(_) => return true,
        }
    }

    true
}

/// Returns `true` if `path` has a `.md` extension (case-insensitive).
pub(crate) fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

/// Validates that `path` has a `.md` extension, returning `UnsupportedFileType` otherwise.
pub(crate) fn ensure_markdown_path(path: &Path, original_rel: &str) -> Result<(), WorkspaceError> {
    if is_markdown_path(path) {
        Ok(())
    } else {
        Err(WorkspaceError::UnsupportedFileType {
            path: original_rel.to_owned(),
        })
    }
}

/// Formats a path inside `root` as a forward-slash workspace-relative string.
pub(crate) fn to_relative_string(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in rel.components() {
        if let Component::Normal(seg) = component {
            parts.push(seg.to_str()?);
        }
    }
    Some(parts.join("/"))
}

/// Lexically normalizes a workspace-relative path and formats it with forward slashes.
pub(crate) fn normalize_relative_string(rel_path: &str) -> Result<String, WorkspaceError> {
    let normalized = normalize_relative(rel_path)?;
    let mut parts = Vec::new();
    for component in normalized.components() {
        if let Component::Normal(seg) = component {
            let seg_str = seg.to_str().ok_or_else(|| WorkspaceError::NotFound {
                path: rel_path.to_owned(),
            })?;
            parts.push(seg_str);
        }
    }
    Ok(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_relative_accepts_clean_and_internal_paths() {
        assert_eq!(normalize_relative("").unwrap(), PathBuf::new());
        assert_eq!(normalize_relative(".").unwrap(), PathBuf::new());
        assert_eq!(
            normalize_relative("./notes.md").unwrap(),
            PathBuf::from("notes.md")
        );
        assert_eq!(
            normalize_relative("a/b/../notes.md").unwrap(),
            PathBuf::from("a/notes.md")
        );
    }

    #[test]
    fn normalize_relative_rejects_escapes_and_absolute_paths() {
        assert!(matches!(
            normalize_relative("../secret.md"),
            Err(WorkspaceError::PathOutsideRoot { .. })
        ));
        assert!(matches!(
            normalize_relative("a/../../secret.md"),
            Err(WorkspaceError::PathOutsideRoot { .. })
        ));
        assert!(matches!(
            normalize_relative(".."),
            Err(WorkspaceError::PathOutsideRoot { .. })
        ));
        assert!(matches!(
            normalize_relative("/etc/passwd"),
            Err(WorkspaceError::PathOutsideRoot { .. })
        ));
    }

    #[test]
    fn markdown_extension_matching() {
        assert!(is_markdown_path(Path::new("notes.md")));
        assert!(is_markdown_path(Path::new("dir/NOTES.MD")));
        assert!(is_markdown_path(Path::new("ReadMe.Md")));
        assert!(!is_markdown_path(Path::new("notes.txt")));
        assert!(!is_markdown_path(Path::new("notes.markdown")));
        assert!(!is_markdown_path(Path::new("README")));
        assert!(!is_markdown_path(Path::new(".md")));
    }
}
