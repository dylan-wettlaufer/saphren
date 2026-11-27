use std::fs;

use saphren_core::{
    DiffLine, FileContent, OpenFileBuffer, PendingChange, WorkspaceError, WorkspaceState,
    sha256_hex,
};
use tempfile::TempDir;

#[test]
fn empty_state_rejects_operations_with_no_workspace_open() {
    let mut state = WorkspaceState::new();
    assert!(state.root().is_none());
    assert!(state.active_file().is_none());
    assert!(state.proposals().is_empty());

    assert!(matches!(
        state.list_files(None),
        Err(WorkspaceError::NoWorkspaceOpen)
    ));
    assert!(matches!(
        state.open_file("notes.md"),
        Err(WorkspaceError::NoWorkspaceOpen)
    ));
    assert!(matches!(
        state.update_buffer("notes.md", "text"),
        Err(WorkspaceError::NoWorkspaceOpen)
    ));
    assert!(matches!(
        state.save_active_file(),
        Err(WorkspaceError::NoWorkspaceOpen)
    ));
    assert!(matches!(
        state.read_file("notes.md"),
        Err(WorkspaceError::NoWorkspaceOpen)
    ));
}

#[test]
fn open_workspace_with_no_active_file_rejects_buffer_mutations() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("notes.md"), "# Notes").unwrap();

    let mut state = WorkspaceState::new();
    let root = state.open_workspace(dir.path()).unwrap().to_path_buf();
    assert_eq!(root, fs::canonicalize(dir.path()).unwrap());
    assert!(state.active_file().is_none());
    assert!(state.proposals().is_empty());
    assert_eq!(state.list_files(None).unwrap(), vec!["notes.md"]);

    assert!(matches!(
        state.update_buffer("notes.md", "edited"),
        Err(WorkspaceError::NoActiveFile)
    ));
    assert!(matches!(
        state.save_active_file(),
        Err(WorkspaceError::NoActiveFile)
    ));
}

#[test]
fn clean_to_dirty_to_clean_save_lifecycle() {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("docs")).unwrap();
    let note_path = dir.path().join("docs/notes.md");
    fs::write(&note_path, "# Draft\nInitial line\n").unwrap();
    fs::write(dir.path().join("other.md"), "Other file on disk").unwrap();

    let mut state = WorkspaceState::new();
    state.open_workspace(dir.path()).unwrap();

    // Open -> Clean
    let initial_hash = sha256_hex("# Draft\nInitial line\n");
    let opened = state.open_file("./docs/../docs/notes.md").unwrap().clone();
    assert_eq!(opened.path, "docs/notes.md");
    assert_eq!(opened.content, "# Draft\nInitial line\n");
    assert_eq!(opened.disk_hash, initial_hash);
    assert_eq!(opened.content_hash(), initial_hash);
    assert!(!opened.is_dirty);

    // Clean -> Dirty via update_buffer (disk remains untouched)
    let updated_text = "# Draft\nInitial line\nAdded paragraph\n";
    let dirty = state.update_buffer("docs/notes.md", updated_text).unwrap().clone();
    assert!(dirty.is_dirty);
    assert_eq!(dirty.content, updated_text);
    assert_eq!(dirty.disk_hash, initial_hash);
    assert_eq!(dirty.content_hash(), sha256_hex(updated_text));
    assert_eq!(
        fs::read_to_string(&note_path).unwrap(),
        "# Draft\nInitial line\n"
    );

    // read_file returns live unsaved buffer for active file, disk content for others
    assert_eq!(
        state.read_file("docs/notes.md").unwrap(),
        FileContent {
            path: "docs/notes.md".to_owned(),
            content: updated_text.to_owned(),
            is_dirty: true,
        }
    );
    assert_eq!(
        state.read_file("./docs/notes.md").unwrap(),
        FileContent {
            path: "docs/notes.md".to_owned(),
            content: updated_text.to_owned(),
            is_dirty: true,
        }
    );
    assert_eq!(
        state.read_file("other.md").unwrap(),
        FileContent {
            path: "other.md".to_owned(),
            content: "Other file on disk".to_owned(),
            is_dirty: false,
        }
    );

    // Dirty -> Clean via save_active_file (writes disk and updates disk_hash)
    let saved_hash = sha256_hex(updated_text);
    let saved = state.save_active_file().unwrap().clone();
    assert!(!saved.is_dirty);
    assert_eq!(saved.content, updated_text);
    assert_eq!(saved.disk_hash, saved_hash);
    assert_eq!(saved.content_hash(), saved_hash);
    assert_eq!(fs::read_to_string(&note_path).unwrap(), updated_text);
    assert_eq!(
        state.read_file("docs/notes.md").unwrap(),
        FileContent {
            path: "docs/notes.md".to_owned(),
            content: updated_text.to_owned(),
            is_dirty: false,
        }
    );

    // Saving an already-clean buffer is idempotent
    let saved_again = state.save_active_file().unwrap().clone();
    assert!(!saved_again.is_dirty);
    assert_eq!(saved_again.disk_hash, saved_hash);

    // Second edit -> save cycle updates disk_hash again
    let final_text = "# Final\n";
    assert!(state.update_buffer("./docs/notes.md", final_text).unwrap().is_dirty);
    let final_saved = state.save_active_file().unwrap().clone();
    assert!(!final_saved.is_dirty);
    assert_eq!(final_saved.disk_hash, sha256_hex(final_text));
    assert_eq!(fs::read_to_string(&note_path).unwrap(), final_text);
}

#[test]
fn reverting_edits_to_disk_content_clears_dirty_flag() {
    let dir = TempDir::new().unwrap();
    let original = "Line 1\r\nCafé 🚀\r\n";
    fs::write(dir.path().join("unicode.md"), original).unwrap();

    let mut state = WorkspaceState::new();
    state.open_workspace(dir.path()).unwrap();
    state.open_file("unicode.md").unwrap();

    // Changing CRLF to LF diverges from disk hash -> Dirty
    let lf_only = "Line 1\nCafé 🚀\n";
    let dirty = state.update_buffer("unicode.md", lf_only).unwrap();
    assert!(dirty.is_dirty);
    assert_eq!(dirty.disk_hash, sha256_hex(original));

    // Reverting to exact disk bytes returns to Clean without saving
    let reverted = state.update_buffer("unicode.md", original).unwrap();
    assert!(!reverted.is_dirty);
    assert_eq!(reverted.disk_hash, sha256_hex(original));
}

#[test]
fn empty_file_transitions_clean_dirty_clean() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("empty.md"), "").unwrap();

    let mut state = WorkspaceState::new();
    state.open_workspace(dir.path()).unwrap();

    let buf = state.open_file("empty.md").unwrap();
    assert!(!buf.is_dirty);
    assert_eq!(buf.disk_hash, sha256_hex(""));

    assert!(state.update_buffer("empty.md", "a").unwrap().is_dirty);
    assert!(!state.update_buffer("empty.md", "").unwrap().is_dirty);
    assert!(state.update_buffer("empty.md", "saved").unwrap().is_dirty);

    let saved = state.save_active_file().unwrap();
    assert!(!saved.is_dirty);
    assert_eq!(saved.disk_hash, sha256_hex("saved"));
}

#[test]
fn update_buffer_rejects_mismatched_and_escaping_paths_without_mutating() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("a.md"), "alpha").unwrap();
    fs::write(dir.path().join("b.md"), "beta").unwrap();

    let mut state = WorkspaceState::new();
    state.open_workspace(dir.path()).unwrap();
    state.open_file("a.md").unwrap();

    assert!(matches!(
        state.update_buffer("b.md", "wrong target"),
        Err(WorkspaceError::ActiveFileMismatch { active, requested })
            if active == "a.md" && requested == "b.md"
    ));
    assert!(matches!(
        state.update_buffer("../outside.md", "escape"),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));
    assert!(matches!(
        state.update_buffer("/etc/passwd", "escape"),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));

    let active = state.active_file().unwrap();
    assert_eq!(active.path, "a.md");
    assert_eq!(active.content, "alpha");
    assert!(!active.is_dirty);
}

#[test]
fn failed_open_file_preserves_existing_active_buffer() {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("folder")).unwrap();
    fs::write(dir.path().join("a.md"), "alpha").unwrap();
    fs::write(dir.path().join("plain.txt"), "not markdown").unwrap();

    let mut state = WorkspaceState::new();
    state.open_workspace(dir.path()).unwrap();
    state.open_file("a.md").unwrap();
    state.update_buffer("a.md", "unsaved alpha").unwrap();

    assert!(matches!(
        state.open_file("missing.md"),
        Err(WorkspaceError::NotFound { .. })
    ));
    assert!(matches!(
        state.open_file("plain.txt"),
        Err(WorkspaceError::UnsupportedFileType { .. })
    ));
    assert!(matches!(
        state.open_file("folder"),
        Err(WorkspaceError::NotAFile { .. })
    ));
    assert!(matches!(
        state.open_file("../escape.md"),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));

    let active = state.active_file().unwrap();
    assert_eq!(active.path, "a.md");
    assert_eq!(active.content, "unsaved alpha");
    assert!(active.is_dirty);
}

#[test]
fn switching_and_closing_files_does_not_write_unsaved_edits() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("a.md"), "alpha").unwrap();
    fs::write(dir.path().join("b.md"), "beta").unwrap();

    let mut state = WorkspaceState::new();
    state.open_workspace(dir.path()).unwrap();

    state.open_file("a.md").unwrap();
    state.update_buffer("a.md", "dirty alpha").unwrap();

    // Switching to b.md loads b.md Clean and leaves a.md untouched on disk
    let b = state.open_file("b.md").unwrap();
    assert_eq!(b.path, "b.md");
    assert_eq!(b.content, "beta");
    assert!(!b.is_dirty);
    assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(), "alpha");

    // Closing b.md clears active_file without touching disk
    state.update_buffer("b.md", "dirty beta").unwrap();
    state.close_file();
    assert!(state.active_file().is_none());
    assert_eq!(fs::read_to_string(dir.path().join("b.md")).unwrap(), "beta");
}

#[test]
fn read_file_returns_live_buffer_even_if_backing_file_deleted() {
    let dir = TempDir::new().unwrap();
    let note_path = dir.path().join("ephemeral.md");
    fs::write(&note_path, "initial").unwrap();

    let mut state = WorkspaceState::new();
    state.open_workspace(dir.path()).unwrap();
    state.open_file("ephemeral.md").unwrap();
    state.update_buffer("ephemeral.md", "unsaved edits").unwrap();

    fs::remove_file(&note_path).unwrap();

    assert_eq!(
        state.read_file("ephemeral.md").unwrap(),
        FileContent {
            path: "ephemeral.md".to_owned(),
            content: "unsaved edits".to_owned(),
            is_dirty: true,
        }
    );
}

#[cfg(unix)]
#[test]
fn symlinks_respect_sandbox_and_internal_alias_reads_live_buffer() {
    use std::os::unix::fs::symlink;

    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("secret.md"), "secret").unwrap();

    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("sub")).unwrap();
    fs::write(dir.path().join("sub/real.md"), "real disk").unwrap();
    symlink(dir.path().join("sub/real.md"), dir.path().join("alias.md")).unwrap();
    symlink(outside.path().join("secret.md"), dir.path().join("escape.md")).unwrap();

    let mut state = WorkspaceState::new();
    state.open_workspace(dir.path()).unwrap();

    assert!(matches!(
        state.open_file("escape.md"),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));
    assert!(matches!(
        state.read_file("escape.md"),
        Err(WorkspaceError::PathOutsideRoot { .. })
    ));

    state.open_file("sub/real.md").unwrap();
    state.update_buffer("sub/real.md", "live unsaved").unwrap();

    let via_alias = state.read_file("alias.md").unwrap();
    assert_eq!(via_alias.path, "alias.md");
    assert_eq!(via_alias.content, "live unsaved");
    assert!(via_alias.is_dirty);
}

#[test]
fn state_types_serialize_and_deserialize_cleanly() {
    let buffer = OpenFileBuffer {
        path: "notes.md".to_owned(),
        content: "# Hello".to_owned(),
        disk_hash: sha256_hex("# Hello"),
        is_dirty: false,
    };
    let roundtrip_buf: OpenFileBuffer =
        serde_json::from_str(&serde_json::to_string(&buffer).unwrap()).unwrap();
    assert_eq!(roundtrip_buf, buffer);

    let proposal = PendingChange {
        id: "550e8400-e29b-41d4-a716-446655440000".to_owned(),
        path: "notes.md".to_owned(),
        base_hash: sha256_hex("# Hello"),
        proposed_content: "# Hello\nWorld".to_owned(),
        reason: "Add greeting body".to_owned(),
        diff_lines: vec![
            DiffLine::Context("# Hello".to_owned()),
            DiffLine::Added("World".to_owned()),
            DiffLine::Removed("Old".to_owned()),
        ],
        created_at: "2026-11-27T17:00:00Z".to_owned(),
    };
    let json = serde_json::to_value(&proposal).unwrap();
    assert_eq!(json["diff_lines"][0]["kind"], "context");
    assert_eq!(json["diff_lines"][1]["kind"], "added");
    assert_eq!(json["diff_lines"][2]["kind"], "removed");

    let roundtrip_prop: PendingChange = serde_json::from_value(json).unwrap();
    assert_eq!(roundtrip_prop, proposal);
}
