import { defineConfig } from "@playwright/test"

/**
 * End-to-end smoke suite. Boots the production server (dist/client must be
 * built first — `bun run test:e2e` handles that) against a throwaway HOME so
 * no real ~/.kanna state is touched.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    // In sandboxed environments a chromium may be preinstalled at a pinned
    // path (PLAYWRIGHT_CHROMIUM_PATH); otherwise Playwright's own download is used.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
})
