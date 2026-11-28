/// <reference types="vite/client" />

import type { SaphrenApi } from "@shared/ipc";

declare global {
  interface Window {
    readonly saphren: SaphrenApi;
  }
}
