/**
 * Headless domain module for Saphren.
 *
 * Contains workspace sandboxing, file I/O, watching, diffing, and proposal state.
 * Zero Electron or React dependencies.
 */

export { WorkspaceError, type WorkspaceErrorCode } from "./error";
export { Workspace, type SearchMatch } from "./workspace";

/** Version of the Saphren core domain module. */
export const CORE_VERSION = "0.1.0";
