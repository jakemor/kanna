import { afterEach, expect, test } from "bun:test"
import { startClientPerformance } from "./clientPerformance"

/**
 * `crypto.randomUUID` is secure-context only, so it is `undefined` over plain
 * http on a LAN/Tailscale hostname. `startClientPerformance` runs in an effect
 * right after the post-login UI mounts, so an unguarded call there blanked the
 * page for Tailscale/LAN HTTP users.
 */

const realCrypto = globalThis.crypto
const realWindow = globalThis.window

/** `bun test` has no DOM, so stand in the four `window` timers this uses. */
function stubWindow() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: setInterval,
      clearInterval: clearInterval,
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
    },
  })
}

afterEach(() => {
  Object.defineProperty(globalThis, "crypto", { value: realCrypto, configurable: true })
  Object.defineProperty(globalThis, "window", { value: realWindow, configurable: true })
})

/** Drops the secure-context-only APIs, leaving `getRandomValues` in place. */
function useInsecureContext() {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) },
  })
}

test("startClientPerformance does not throw without crypto.randomUUID", () => {
  stubWindow()
  useInsecureContext()
  expect(typeof crypto.randomUUID).toBe("undefined")

  let stop: (() => void) | undefined
  expect(() => { stop = startClientPerformance(() => ({ socket_subscriptions: 1 })) }).not.toThrow()
  stop?.()
})

test("startClientPerformance still does not throw with no crypto at all", () => {
  stubWindow()
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined })
  let stop: (() => void) | undefined
  expect(() => { stop = startClientPerformance(() => ({})) }).not.toThrow()
  stop?.()
})

test("generateUUID returns a v4 UUID in an insecure context", async () => {
  const { generateUUID } = await import("../lib/utils")
  useInsecureContext()

  const ids = new Set<string>()
  for (let i = 0; i < 1_000; i++) {
    const id = generateUUID()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    ids.add(id)
  }
  expect(ids.size).toBe(1_000)
})