# AGENTS.md

Saphren is a local-first desktop workspace for writing Markdown alongside AI agents.
Read `docs/saphren-v0.1-spec.md` and `docs/ARCHITECTURE.md` before making architectural or scope decisions.

## Repo Layout
- `src/core/` — Headless TypeScript domain (workspace sandbox, file I/O, file watcher, diffs, proposal state). Zero Electron or React dependencies.
- `src/mcp/` — Local Streamable HTTP MCP server (`@modelcontextprotocol/sdk`). Depends only on `src/core/`.
- `src/shared/` — Shared IPC channel names, request/response types, and event payloads.
- `src/main/` — Thin Electron main process (BrowserWindow, IPC handlers, event forwarding, app lifecycle).
- `src/preload/` — Thin `contextBridge` preload exposing the typed `window.saphren` API.
- `src/renderer/` — Thin React + TypeScript + Tailwind renderer.

## Hard Architectural Rules
1. **Keep the renderer dumb:** Never implement diffing, hashing, conflict detection, or filesystem logic in `src/renderer/`. All domain logic belongs in `src/core/`.
2. **Keep `src/core/` and `src/mcp/` framework-free:** Never import `electron` or `react` in `src/core/` or `src/mcp/`.
3. **Preserve Electron security boundaries:** Keep `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. All renderer ↔ main communication must use typed channels in `src/shared/ipc.ts` exposed via `src/preload/`.
4. **No direct disk writes from MCP:** `src/mcp/` tools must never write to disk. All edits go through `propose_edit` and require explicit user approval.
5. **Enforce the workspace sandbox:** Every file path must be lexically normalized, resolved relative to `workspace.root`, canonicalized via `fs.realpathSync`, and verified to stay inside `workspace.root` (including symlink escape checks).
6. **Respect v0.1 scope:** Do not add tabs, WYSIWYG/Live Preview, per-hunk diffing, ACP chat, or canvas features unless explicitly requested.

## Verification
Run relevant checks before finishing a task:
- Core & MCP tests: `npm test`
- Typecheck: `npm run typecheck`
- Production build: `npm run build`

## Git & Conventional Commits
All commit messages **must** strictly follow [Conventional Commits](https://www.conventionalcommits.org/).

**Format:** `<type>(<scope>): <imperative summary>`

- **Allowed types:** `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `style`, `perf`, `ci`
- **Recommended scopes:** `core`, `mcp`, `main`, `preload`, `ui`, `shared`, `docs`, `deps` (optional if repo-wide)
- **Rules:**
  - Lowercase type and scope, imperative mood, no trailing period, max ~72 chars on the subject line.
  - Keep commits atomic—one logical change per commit.

**Examples:**
- `feat(core): add workspace path sandbox validation`
- `feat(mcp): implement propose_edit tool over streamable http`
- `fix(ui): prevent conflict banner flicker on buffer sync`
- `test(core): cover dirty buffer conflict on proposal accept`
- `docs: add v0.1 spec and architecture`

### Branch Naming
- **Format:** `<type>/<short-kebab-description>`
- **Prefixes:** `feat/`, `fix/`, `refactor/`, `docs/`, `chore/`, `test/`
- **Examples:** `feat/mcp-propose-edit`, `fix/dirty-buffer-conflict`, `chore/electron-ipc-setup`

## Comments
- Write concise comments **only** for non-obvious logic, invariants, or edge-case workarounds (explain *why*, never *what*).
- Do not narrate self-explanatory code or add redundant docstrings to private helpers.
- Use brief JSDoc (`/** ... */`) comments on public exported types, classes, and functions in `src/core/`, `src/mcp/`, and `src/shared/`.

## Testing
- **Focus tests on `src/core/` and `src/mcp/`:** Test invariants, state transitions, and edge cases (path traversal/symlink escapes, dirty-buffer conflicts, `baseHash` mismatches on `acceptProposal`, `read_file` returning live unsaved buffers, and `propose_edit` never writing to disk).
- **Skip trivial UI tests:** Do not add frontend unit tests for basic component rendering, layout, or styling. Rely on `npm run typecheck` and `src/shared/ipc.ts` for frontend contract safety in v0.1.
- Write a targeted regression test when fixing a non-trivial bug in `src/core/` or `src/mcp/`.
