import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import {
  coreVersion,
  createMcpServer,
  DEFAULT_BIND_ADDR,
  DEFAULT_BIND_HOST,
  DEFAULT_BIND_PORT,
  MCP_PATH,
} from "./index";

describe("saphren mcp module", () => {
  it("exposes core version, default address, and builds an McpServer", () => {
    expect(coreVersion().length).toBeGreaterThan(0);
    expect(DEFAULT_BIND_HOST).toBe("127.0.0.1");
    expect(DEFAULT_BIND_PORT).toBe(4721);
    expect(DEFAULT_BIND_ADDR).toBe("127.0.0.1:4721");
    expect(MCP_PATH).toBe("/mcp");

    const server = createMcpServer();
    expect(server).toBeInstanceOf(McpServer);
  });
});
