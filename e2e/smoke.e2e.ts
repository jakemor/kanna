import { expect, test } from "@playwright/test"
import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const APP_VERSION = (JSON.parse(readFileSync(path.join(ROOT_DIR, "package.json"), "utf8")) as { version: string }).version

/**
 * Boots the real production server (Bun + dist/client) with an isolated HOME
 * and drives it through a browser: app shell, WebSocket round trip, the
 * command palette's Add Project browser (fs.list → project.open → sidebar
 * snapshot), and the settings route. No agent turns — those need provider
 * credentials.
 */

const PORT = 43119
const BASE_URL = `http://127.0.0.1:${PORT}`

let serverProcess: ChildProcess | null = null
let homeDir: string

async function waitForHealth(timeoutMs = 30_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/health`)
      if (response.ok) return
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error("Server did not become healthy in time")
}

test.beforeAll(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "kanna-e2e-"))
  const projectDir = path.join(homeDir, "Projects", "demo-app")
  await mkdir(projectDir, { recursive: true })
  await writeFile(path.join(projectDir, "README.md"), "# demo\n", "utf8")

  serverProcess = spawn("bun", ["src/server/cli.ts", "--no-open", "--port", String(PORT)], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOME: homeDir,
      KANNA_DISABLE_SELF_UPDATE: "1",
    },
    stdio: "ignore",
  })
  await waitForHealth()
})

test.afterAll(async () => {
  const exited = serverProcess
    ? new Promise((resolve) => serverProcess?.once("exit", resolve))
    : Promise.resolve()
  serverProcess?.kill()
  await exited
  await rm(homeDir, { recursive: true, force: true })
})

test.beforeEach(async ({ page }) => {
  // Skip the first-run changelog redirect so tests land on the home screen.
  await page.addInitScript((version) => {
    window.localStorage.setItem("kanna:last-seen-version", version)
  }, APP_VERSION)
})

test("serves the app shell and connects the socket", async ({ page }) => {
  await page.goto(BASE_URL)
  await expect(page).toHaveTitle(/Kanna/)
  // The sidebar reports the live WebSocket state; "Connected" proves the
  // subscription round trip delivered the first sidebar snapshot.
  await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 15_000 })
})

test("adds a project through the command palette browser", async ({ page }) => {
  await page.goto(BASE_URL)
  // The home page's "Project" button opens the palette's Add Project page.
  await page.getByRole("button", { name: "Project", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("Choose Existing…")).toBeVisible()
  await dialog.getByText("Choose Existing…").click()

  // Jump straight to the demo project directory via a typed path…
  const input = dialog.getByRole("combobox")
  await input.fill("~/Projects/demo-app")
  await input.press("Enter")

  // …then open it as a project via the footer's "⌘↵ Open" button (the
  // pinned "Open demo-app" row is highlighted, so the footer targets it).
  await dialog.getByRole("button", { name: /Open demo-app/ }).click()

  // The project lands in the sidebar via a sidebar snapshot broadcast.
  await expect(page.getByText("demo-app").first()).toBeVisible({ timeout: 15_000 })
})

test("renders the settings page", async ({ page }) => {
  await page.goto(`${BASE_URL}/settings/appearance`)
  await expect(page.getByText("Settings", { exact: true }).first()).toBeVisible()
})

test("health endpoint responds", async () => {
  const response = await fetch(`${BASE_URL}/health`)
  expect(response.ok).toBe(true)
})
