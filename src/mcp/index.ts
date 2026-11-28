/**
 * Local Streamable HTTP MCP server module for Saphren.
 *
 * Exposes workspace tools over `@modelcontextprotocol/sdk` and depends only on `src/core`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CORE_VERSION } from "@core/index";

/** Default local loopback host for the Saphren MCP server. */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/** Default local TCP port for the Saphren MCP server. */
export const DEFAULT_BIND_PORT = 4721;

/** Default local bind address for the Saphren MCP server. */
export const DEFAULT_BIND_ADDR = `${DEFAULT_BIND_HOST}:${DEFAULT_BIND_PORT}`;

/** HTTP path where the Streamable HTTP MCP endpoint is mounted. */
export const MCP_PATH = "/mcp";

/** Returns the underlying core version coupled to this MCP module. */
export function coreVersion(): string {
  return CORE_VERSION;
}

/** Builds a configured placeholder `McpServer` instance for Saphren. */
export function createMcpServer(): McpServer {
  return new McpServer({
    name: "saphren",
    version: CORE_VERSION,
  });
}
