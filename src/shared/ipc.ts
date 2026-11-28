/** Typed IPC channel names shared across main, preload, and renderer. */
export const IPC_CHANNELS = {
  GET_APP_INFO: "saphren:get-app-info",
} as const;

/** Runtime metadata returned by the main process. */
export interface AppInfo {
  coreVersion: string;
  mcpDefaultAddr: string;
}

/** Typed API exposed to the renderer on `window.saphren`. */
export interface SaphrenApi {
  getAppInfo: () => Promise<AppInfo>;
}
