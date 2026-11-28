import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type AppInfo, type SaphrenApi } from "@shared/ipc";

const api: SaphrenApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_INFO) as Promise<AppInfo>,
};

contextBridge.exposeInMainWorld("saphren", api);
