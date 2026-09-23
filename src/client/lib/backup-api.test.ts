import { afterEach, expect, test } from "bun:test"
import { backupRequest } from "./backup-api"
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test("old server HTML fallback gives actionable error instead of a browser JSON parse error", async () => {
  globalThis.fetch = (async () => new Response("<!doctype html><html></html>", { headers: { "Content-Type": "text/html" } })) as typeof fetch
  await expect(backupRequest()).rejects.toThrow("Restart Kanna")
})

test("backup requests preserve the current browser host through a relative URL", async () => {
  let requested: unknown
  globalThis.fetch = (async (input: unknown) => { requested = input; return Response.json({ connected: false }) }) as typeof fetch
  expect(await backupRequest()).toEqual({ connected: false })
  expect(requested).toBe("/api/backups")
})
