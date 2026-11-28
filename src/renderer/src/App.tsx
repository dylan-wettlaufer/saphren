import { useEffect, useState } from "react";
import type { AppInfo } from "@shared/ipc";

export default function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void window.saphren?.getAppInfo().then(setAppInfo);
  }, []);

  return (
    <main className="flex h-screen w-screen items-center justify-center bg-neutral-950 text-neutral-100">
      <div className="text-center">
        <h1 className="text-xl font-semibold tracking-tight">Saphren</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Local-first Markdown workspace
        </p>
        {appInfo && (
          <p className="mt-3 font-mono text-xs text-neutral-500">
            v{appInfo.coreVersion} · MCP {appInfo.mcpDefaultAddr}
          </p>
        )}
      </div>
    </main>
  );
}
