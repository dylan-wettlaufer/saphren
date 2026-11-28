/**
 * Headless domain module for Saphren.
 *
 * Contains workspace sandboxing, file I/O, watching, diffing, and proposal state.
 * Zero Electron or React dependencies.
 */

export { WorkspaceError, type WorkspaceErrorCode } from "./error";
export { hasContentChanged, hashContent } from "./hash";
export { Workspace, type SearchMatch } from "./workspace";
export {
  WorkspaceState,
  type CloseActiveFileOptions,
  type DiskSyncResult,
  type OpenFileBuffer,
  type OpenFileOptions,
  type ReadFileResult,
  type SaveActiveFileOptions,
  type SaveActiveFileResult,
} from "./workspace-state";

/** Version of the Saphren core domain module. */
export const CORE_VERSION = "0.1.0";
