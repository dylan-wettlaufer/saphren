use std::fs;

use saphren_core::{SearchMatch, Workspace, WorkspaceError};
use tempfile::TempDir;

#[test]
fn open_valid_workspace_canonicalizes_root() {
    let dir = TempDir::new().unwrap();
    let ws = Workspace::open(dir.path()).unwrap();
    assert_eq!(ws.root(), fs::canonicalize(dir.path()).unwrap());
}

#[test]
fn open_rejects_missing_and_file_roots() {
    let dir = TempDir::new().unwrap();

    let missing = dir.path().join("does-not-exist");
    assert!(matches!(
        Workspace::open(&missing),
        Err(WorkspaceError::InvalidWorkspaceRoot { .. })
    ));

    let file = dir.path().join("notes.md");
    fs::write(&file, "# hi").unwrap();
    assert!(matches!(
        Workspace::open(&file),
        Err(WorkspaceError::InvalidWorkspaceRoot { .. })
    ));
}

#[test]
fn path_traversal_returns_path_outside_root() {
    let parent = TempDir::new().unwrap();
    let root = parent.path().join("workspace");
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::write(parent.path().join("outside.md"), "secret").unwrap();

    let ws = Workspace::open(&root).unwrap();

    for escape in [
        "../outside.md",
        "../nonexistent.md",
        "nested/../../outside.md",
        "nested/../../nonexistent.md",
    ] {
        assert!(
            matches!(ws.read_file(escape), Err(WorkspaceError::PathOutsideRoot { .. })),
            "expected PathOutsideRoot on read_file({escape})"
        );
        assert!(
            matches!(
                ws.save_file(escape, "pwned"),
                Err(WorkspaceError::PathOutsideRoot { .. })
            ),
            "expected PathOutsideRoot on save_file({escape})"
        );
    }

    assert!(matches!(
        ws.list_files(Some("..")),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));
    assert!(matches!(
        ws.list_files(Some("nested/../..")),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));
    assert_eq!(
        fs::read_to_string(parent.path().join("outside.md")).unwrap(),
        "secret"
    );
    assert!(!parent.path().join("nonexistent.md").exists());
}

#[test]
fn absolute_paths_return_path_outside_root() {
    let dir = TempDir::new().unwrap();
    let inside = dir.path().join("notes.md");
    fs::write(&inside, "hello").unwrap();

    let ws = Workspace::open(dir.path()).unwrap();
    let inside_abs = ws.root().join("notes.md");
    let inside_str = inside_abs.to_str().unwrap();

    assert!(matches!(
        ws.read_file(inside_str),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));
    assert!(matches!(
        ws.save_file(inside_str, "overwrite"),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));
    assert!(matches!(
        ws.list_files(Some(ws.root().to_str().unwrap())),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));

    let outside_abs = std::env::temp_dir().join("saphren-outside.md");
    let outside_str = outside_abs.to_str().unwrap();
    assert!(matches!(
        ws.read_file(outside_str),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));
}

#[cfg(unix)]
#[test]
fn symlink_to_outside_file_is_blocked_and_omitted() {
    use std::os::unix::fs::symlink;

    let outside = TempDir::new().unwrap();
    let secret = outside.path().join("secret.md");
    fs::write(&secret, "top-secret-token").unwrap();

    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("safe.md"), "safe content").unwrap();
    symlink(&secret, dir.path().join("escape.md")).unwrap();

    let ws = Workspace::open(dir.path()).unwrap();

    assert!(matches!(
        ws.read_file("escape.md"),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));
    assert!(matches!(
        ws.save_file("escape.md", "tampered"),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));
    assert_eq!(fs::read_to_string(&secret).unwrap(), "top-secret-token");

    assert_eq!(ws.list_files(None).unwrap(), vec!["safe.md"]);
    assert!(ws.search_files("top-secret-token").unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn symlink_to_outside_directory_is_blocked_and_omitted() {
    use std::os::unix::fs::symlink;

    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("secret.md"), "outside-needle").unwrap();

    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("notes.md"), "inside").unwrap();
    symlink(outside.path(), dir.path().join("escape_dir")).unwrap();

    let ws = Workspace::open(dir.path()).unwrap();

    assert!(matches!(
        ws.list_files(Some("escape_dir")),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));
    assert!(matches!(
        ws.read_file("escape_dir/secret.md"),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));
    assert!(matches!(
        ws.read_file("escape_dir/missing.md"),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));
    assert!(matches!(
        ws.save_file("escape_dir/new.md", "boom"),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));
    assert!(!outside.path().join("new.md").exists());

    assert_eq!(ws.list_files(None).unwrap(), vec!["notes.md"]);
    assert!(ws.search_files("outside-needle").unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn dangling_symlink_pointing_outside_root_is_blocked() {
    use std::os::unix::fs::symlink;

    let outside = TempDir::new().unwrap();
    let target = outside.path().join("created-outside.md");

    let dir = TempDir::new().unwrap();
    symlink(&target, dir.path().join("dangling.md")).unwrap();
    symlink(dir.path().join("dangling.md"), dir.path().join("hop.md")).unwrap();

    let ws = Workspace::open(dir.path()).unwrap();

    for path in ["dangling.md", "hop.md"] {
        assert!(
            matches!(ws.read_file(path), Err(WorkspaceError::PathOutsideRoot { .. })),
            "expected PathOutsideRoot on read_file({path})"
        );
        assert!(
            matches!(
                ws.save_file(path, "should not escape"),
                Err(WorkspaceError::PathOutsideRoot { .. })
            ),
            "expected PathOutsideRoot on save_file({path})"
        );
    }
    assert!(!target.exists());
}

#[cfg(unix)]
#[test]
fn valid_internal_symlinks_work_and_cycles_terminate() {
    use std::os::unix::fs::symlink;

    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("sub")).unwrap();
    fs::write(dir.path().join("sub/real.md"), "initial").unwrap();
    symlink(dir.path().join("sub/real.md"), dir.path().join("alias.md")).unwrap();
    symlink(dir.path(), dir.path().join("sub/loop_to_root")).unwrap();

    let ws = Workspace::open(dir.path()).unwrap();

    assert_eq!(ws.read_file("alias.md").unwrap(), "initial");
    ws.save_file("alias.md", "updated via alias").unwrap();
    assert_eq!(ws.read_file("sub/real.md").unwrap(), "updated via alias");

    // Symlink cycle back to root must not infinite-loop.
    let files = ws.list_files(None).unwrap();
    assert_eq!(files, vec!["alias.md", "sub/real.md"]);
}

#[test]
fn list_files_filters_markdown_skips_hidden_and_sorts() {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("docs/nested")).unwrap();
    fs::create_dir_all(dir.path().join(".git")).unwrap();

    fs::write(dir.path().join("zeta.md"), "z").unwrap();
    fs::write(dir.path().join("ALPHA.MD"), "a").unwrap();
    fs::write(dir.path().join("docs/spec.md"), "spec").unwrap();
    fs::write(dir.path().join("docs/nested/deep.md"), "deep").unwrap();
    fs::write(dir.path().join("notes.txt"), "ignore").unwrap();
    fs::write(dir.path().join("README"), "ignore").unwrap();
    fs::write(dir.path().join(".hidden.md"), "ignore").unwrap();
    fs::write(dir.path().join(".git/commit.md"), "ignore").unwrap();

    let ws = Workspace::open(dir.path()).unwrap();

    assert_eq!(
        ws.list_files(None).unwrap(),
        vec![
            "ALPHA.MD",
            "docs/nested/deep.md",
            "docs/spec.md",
            "zeta.md",
        ]
    );
    assert_eq!(ws.list_files(Some("")).unwrap(), ws.list_files(None).unwrap());
    assert_eq!(ws.list_files(Some(".")).unwrap(), ws.list_files(None).unwrap());

    assert_eq!(
        ws.list_files(Some("docs")).unwrap(),
        vec!["docs/nested/deep.md", "docs/spec.md"]
    );

    assert!(matches!(
        ws.list_files(Some("missing")),
        Err(WorkspaceError::NotFound { .. })
    ));
    assert!(matches!(
        ws.list_files(Some("zeta.md")),
        Err(WorkspaceError::NotADirectory { .. })
    ));
}

#[test]
fn search_files_is_case_insensitive_and_deterministic() {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("sub")).unwrap();

    fs::write(
        dir.path().join("a.md"),
        "Line one\r\nTODO: write specs\r\nAnother todo item\n",
    )
    .unwrap();
    fs::write(dir.path().join("sub/b.md"), "No match here\nToDo at line two").unwrap();
    fs::write(dir.path().join("ignored.txt"), "TODO in txt file").unwrap();
    // Invalid UTF-8 bytes in a .md file should be skipped gracefully.
    fs::write(dir.path().join("binary.md"), [0xff, 0xfe, 0xfd]).unwrap();

    let ws = Workspace::open(dir.path()).unwrap();

    assert_eq!(
        ws.search_files("tOdO").unwrap(),
        vec![
            SearchMatch {
                path: "a.md".to_owned(),
                line: 2,
                snippet: "TODO: write specs".to_owned(),
            },
            SearchMatch {
                path: "a.md".to_owned(),
                line: 3,
                snippet: "Another todo item".to_owned(),
            },
            SearchMatch {
                path: "sub/b.md".to_owned(),
                line: 2,
                snippet: "ToDo at line two".to_owned(),
            },
        ]
    );

    assert!(ws.search_files("").unwrap().is_empty());
    assert!(ws.search_files("nonexistent-term").unwrap().is_empty());
}

#[test]
fn read_and_save_markdown_files() {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("folder")).unwrap();
    fs::write(dir.path().join("plain.txt"), "not markdown").unwrap();

    let ws = Workspace::open(dir.path()).unwrap();

    // Missing file inside workspace.
    assert!(matches!(
        ws.read_file("missing.md"),
        Err(WorkspaceError::NotFound { .. })
    ));
    // Directory is not a file.
    assert!(matches!(
        ws.read_file("folder"),
        Err(WorkspaceError::NotAFile { .. })
    ));
    assert!(matches!(
        ws.save_file("folder", "nope"),
        Err(WorkspaceError::NotAFile { .. })
    ));
    // Non-markdown extension rejected on read and save.
    assert!(matches!(
        ws.read_file("plain.txt"),
        Err(WorkspaceError::UnsupportedFileType { .. })
    ));
    assert!(matches!(
        ws.save_file("new.txt", "nope"),
        Err(WorkspaceError::UnsupportedFileType { .. })
    ));

    // Create new file with nested parent directories.
    ws.save_file("deep/nested/note.md", "# Title\nBody").unwrap();
    assert_eq!(ws.read_file("deep/nested/note.md").unwrap(), "# Title\nBody");

    // Overwrite existing file (via normalized internal `..` path).
    ws.save_file("deep/nested/../nested/note.md", "# Updated")
        .unwrap();
    assert_eq!(ws.read_file("deep/nested/note.md").unwrap(), "# Updated");

    // Ensure no temporary atomic-write files remain on disk.
    let entries: Vec<String> = fs::read_dir(dir.path().join("deep/nested"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec!["note.md"]);
}
