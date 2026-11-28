# Saphren v0.1 Architecture

Saphren uses a **headless TypeScript core** paired with a **thin Electron + React UI shell**. All workspace state, file watching, diffing, conflict detection, and MCP protocol logic live in pure Node/TypeScript modules with zero Electron or React UI dependencies.

## 1. Repository & Module Layout

```text
saphren/
├── electron.vite.config.ts    # electron-vite config for main, preload, and renderer
├── package.json               # Root dependencies & scripts
├── tsconfig.json              # TypeScript project references (node + web)
├── vitest.config.ts           # Unit & integration test runner for core and mcp
├── docs/                      # Planning vault (specs, architecture)
└── src/
    ├── core/                  # Headless domain: sandbox, file I/O, watcher, diffs, proposals
    ├── mcp/                   # Local MCP server (@modelcontextprotocol/sdk) exposing 4 workspace tools
    ├── shared/                # Shared IPC channel names, request/response types, and event payloads
    ├── main/                  # Thin Electron main process: BrowserWindow, IPC handlers, app lifecycle
    ├── preload/               # Thin contextBridge preload exposing typed window.saphren API
    └── renderer/              # Thin React + TypeScript + Tailwind renderer (zero business logic)
```

### Dependency Direction

- `src/core/` depends on nothing else in `src/` (pure Node/TypeScript; zero Electron or React imports).
- `src/mcp/` depends only on `src/core/` (and `@modelcontextprotocol/sdk`).
- `src/shared/` holds pure TypeScript types and IPC channel constants shared across process boundaries.
- `src/main/` depends on `src/core/`, `src/mcp/`, and `src/shared/`, wires them together at startup, registers `ipcMain` handlers, and forwards core events to the renderer.
- `src/preload/` depends only on `src/shared/` and `electron` (`contextBridge`, `ipcRenderer`), exposing the typed `window.saphren` bridge.
- `src/renderer/` calls the main process exclusively through `window.saphren` and listens to typed IPC events.

## 2. Core Domain (`src/core/`)

### Workspace Sandbox

- Every path passed by the UI or an MCP client is lexically normalized (rejecting absolute paths and `..` escapes), resolved relative to `workspace.root`, canonicalized via `fs.realpathSync`, and verified to remain inside `workspace.root`.
- Any path traversal attempt (e.g., `../`), absolute path, or symlink (including dangling symlink chains) escaping the root throws `WorkspaceError` with code `"PathOutsideRoot"`.

### Core Data Types

- **`WorkspaceState`** (owned in the Electron main process):
  - `root: string | null`
  - `openFile: OpenFileBuffer | null` (tracks the active file's relative path, live unsaved text, `diskHash`, and `isDirty`)
  - `proposals: Map<string, PendingChange>` (keyed by UUID; at most one active pending proposal per file path in v0.1, or latest replaces prior)
- **`PendingChange`**:
  - `id: string`
  - `path: string` (relative to workspace root)
  - `baseHash: string` (SHA-256 via `node:crypto` of the content the proposal was generated against)
  - `proposedContent: string`
  - `reason: string`
  - `diffLines: DiffLine[]` (computed in `src/core/` via `diff`: `"context" | "added" | "removed"`)
  - `createdAt: string` (ISO-8601)

### State Machines

**Active File Lifecycle**

- `Clean` → user types → `Dirty`
- `Dirty` → user hits `Cmd/Ctrl+S` → `Clean` (writes atomically to disk, updates `diskHash`)
- `Clean` → file watcher detects external disk edit → silently reloads buffer and emits `file:reloaded`
- `Dirty` → file watcher detects external disk edit → `ExternalConflict` (UI prompts Reload vs. Keep Local)

**Proposal Lifecycle**

- Agent calls `propose_edit` → `Pending` (emits `proposal:created`; disk untouched)
- User clicks **Reject** → `Rejected` (removed from queue; disk and buffer untouched)
- User clicks **Accept**:
  - If current content hash equals `baseHash` → writes `proposedContent` atomically to disk, updates open buffer if active, removes proposal → `Accepted`
  - If current content hash differs from `baseHash` → returns `Conflicted` state (UI shows Keep My Edits vs. Overwrite with Proposal)

## 3. Local MCP Server (`src/mcp/`)

- **Transport:** Streamable HTTP (`@modelcontextprotocol/sdk` using `McpServer` + `StreamableHTTPServerTransport` over Node's `http` server) listening on `http://127.0.0.1:4721/mcp` (falls back to an ephemeral port if `4721` is occupied).
- **Session Management:** In-memory session registry keyed by `mcp-session-id` so external CLI agents (Claude Code, Codex, Gemini CLI) can connect concurrently to the running desktop app.
- **Write Safety Rule:** MCP tools **never** write directly to disk. All edits go through `propose_edit`.

### v0.1 Tool Contract

| **Tool** | **Input JSON** | **Output JSON** | **Notes** |
|---|---|---|---|
| `list_files` | `{ "subpath"?: string }` | `{ "files": string[] }` | Lists `.md` files relative to workspace root |
| `read_file` | `{ "path": string }` | `{ "path": string, "content": string, "is_dirty": boolean }` | Reads live in-memory buffer if file is currently open, else disk |
| `search_files` | `{ "query": string }` | `{ "matches": [{ "path", "line", "snippet" }] }` | Case-insensitive substring search across `.md` files |
| `propose_edit` | `{ "path": string, "new_content": string, "reason": string }` | `{ "proposal_id": string, "status": "pending_review" }` | Computes diff, queues `PendingChange`, emits UI event |

## 4. Electron IPC Contract (`src/main/` <-> `src/preload/` <-> `src/renderer/`)

All IPC channel names, command signatures, and event payloads live in `src/shared/ipc.ts` so TypeScript enforces end-to-end contract safety across main, preload, and renderer. The `BrowserWindow` runs with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`, exposing a minimal `window.saphren` bridge via `contextBridge`.

### Commands (Renderer → Main via `ipcRenderer.invoke`)

- `openWorkspace(path: string): Promise<WorkspaceSnapshot>`
- `openFile(path: string): Promise<OpenFileView>`
- `updateBuffer(path: string, content: string): Promise<void>` _(syncs live editor text to core so MCP `read_file` sees unsaved edits)_
- `saveActiveFile(): Promise<void>`
- `acceptProposal(id: string, forceOverwrite: boolean): Promise<AcceptResult>`
- `rejectProposal(id: string): Promise<void>`
- `acceptAllProposals(): Promise<BatchAcceptResult>`
- `getMcpStatus(): Promise<McpStatus>` _(returns `{ running, url }`)_

### Events (Main → Renderer via `webContents.send`)

- `workspace:tree-updated` — file created, renamed, or deleted on disk
- `file:reloaded` / `file:external-conflict` — external disk change on the open file
- `proposal:created` — triggers blue dot in file tree and enables review banner
- `proposal:resolved` — clears blue dot after Accept or Reject

## 5. Architecture Decision Records (ADRs)

- **ADR-001: Headless TypeScript Core + Thin Electron Shell**
  - _Why:_ Keeps the entire codebase in one language (TypeScript), integrates natively with the official `@modelcontextprotocol/sdk`, and provides a predictable Chromium + Node desktop runtime for React + Tailwind (and Excalidraw in v0.2), while keeping `src/core/` and `src/mcp/` decoupled from Electron and UI code.
- **ADR-002: Staged Writes Only via MCP**
  - _Why:_ Enforces the human-directed principle and prevents race conditions when the user has unsaved edits in the active buffer.
- **ADR-003: Streamable HTTP over Stdio for Local MCP**
  - _Why:_ External CLI agents need to connect to an already-running Saphren desktop window rather than spawning a separate headless child process per agent.
- **ADR-004: File-Level Proposal Acceptance in v0.1**
  - _Why:_ Avoids partial-hunk patch reconciliation complexity in v0.1; per-hunk acceptance moves to v0.2.
