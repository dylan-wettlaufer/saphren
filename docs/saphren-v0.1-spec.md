Saphren is a native, lightweight, local-first workspace for writing, planning, and thinking alongside AI agents.

## Golden Path

1. I launch Saphren and open a local folder.
2. I see the folder's files in a simple file tree and click `notes.md` to open it in the editor.
3. I read and edit the text directly (saving with `Cmd/Ctrl+S`).
4. In my terminal, I tell an AI agent CLI (connected to Saphren's local MCP server) to expand section 2 of `notes.md`.
5. Within a second, a blue dot appears next to `notes.md` in the file tree.
6. I click `notes.md` to view the red/green diff between the current content and the agent's proposed changes, along with the agent's reason.
7. I click **Accept** (or **Reject**) for the file proposal—or **Accept All** if multiple files have pending proposals. Accepted changes are written to disk.

## Key Edge Cases (v0.1)
- **Reject:** Discards the pending proposal; disk and editor buffer remain untouched.
- **Dirty/Conflict:** If I edit `notes.md` after a proposal arrives, Saphren flags a conflict rather than silently overwriting my changes.
- **MCP Visibility:** A minimal status bar shows that the local MCP server is running and displays its address/config.

## Out of Scope for v0.1
- **Canvas:** No infinite canvas for diagrams (v0.2) or freehand drawing (v0.3).
- **ACP Chat Sidebar:** No in-app chat; agent collaboration is strictly through MCP.
- **WYSIWYG / Live Preview:** Plain-text Markdown editor only; no rendered preview or Live Preview.
- **Editor Tabs:** Single active file at a time (file tree for navigation, no multi-tab bar).
- **Per-hunk Diff Acceptance:** Accept/Reject operates at the file-proposal level, not individual diff hunks.
	
