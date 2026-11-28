import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@core": resolve("src/core"),
      "@mcp": resolve("src/mcp"),
      "@shared": resolve("src/shared"),
    },
  },
  test: {
    environment: "node",
    include: ["src/core/**/*.test.ts", "src/mcp/**/*.test.ts"],
  },
});
