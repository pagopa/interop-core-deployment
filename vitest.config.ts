import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Prefer .ts over .js so Vitest imports the TypeScript source directly
    // instead of the run-wrapper at scripts/secret-references-repo-inventory.js
    extensions: [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".json"],
  },
  test: {
    environment: "node",
    include: ["scripts/__tests__/**/*.test.ts"],
  },
});
