import { afterEach, expect, test } from "bun:test"
import { startClientPerformance } from "./clientPerformance"

/**
 * `crypto.randomUUID` is secure-context only, so it is `undefined` over plain
 * http on a LAN/Tailscale hostname. `startClientPerformance` runs in an effect
 * right after the post-login UI mounts, so an unguarded call there blanked the
 * page for Tailscale/LAN HTTP users.
 */

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const realCrypto = globalThis.crypto
const realWindow = globalThis.window
const realDocument = globalThis.document
const realFetch = globalThis.fetch

/** Captures the 60s interval callback so the body can be run on demand. */
let tick: (() => void) | null = null

afterEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: realCrypto, configurable: true, writable: true, enumerable: true,
  })
  Object.defineProperty(globalThis, "fetch", {
    value: realFetch, configurable: true, writable: true, enumerable: true,
  })
  // `bun test` has no DOM, so `window`/`document` never existed. Delete rather
  // than restore an `undefined` property, so later tests still see them absent
  // (and a non-writable stub cannot break a later test that assigns to them).
  for (const [key, value] of [["window", realWindow], ["document", realDocument]] as const) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key]
    else Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  tick = null
})

/**
 * Stands in the four `window` timers this module uses. The interval is captured
 * instead of armed, so the tests don't keep Bun's event loop alive.
 */
function stubWindow() {
  tick = null
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      setInterval: (fn: () => void) => { tick = fn; return 1 },
      clearInterval: () => {},
      setTimeout: (fn: () => void) => { fn(); return 2 },
      clearTimeout: () => {},
    },
  })
  // The interval body also reads document.visibilityState and counts DOM nodes.
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: { visibilityState: "visible", getElementsByTagName: () => ({ length: 3 }) },
  })
}

/** Drops the secure-context-only API, leaving `getRandomValues` in place. */
function useInsecureContext() {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    writable: true,
    value: { getRandomValues: (a: Uint8Array) => realCrypto.getRandomValues(a) },
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

test("posts a usable clientId in an insecure context", async () => {
  stubWindow()
  useInsecureContext()

  type Posted = { clientId: string; metrics: Record<string, { count: number; total: number; max: number }> }
  const captured: { body: Posted | null } = { body: null }
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (_url: string, init: { body: string }) => {
      captured.body = JSON.parse(init.body) as Posted
      return Promise.resolve(new Response("{}"))
    },
  })

  const stop = startClientPerformance(() => ({ socket_subscriptions: 1 }))
  expect(tick).not.toBeNull()
  // The real interval is 60s; fire the captured callback directly.
  ;(tick as unknown as () => void)()
  await Bun.sleep(10)

  const posted = captured.body
  expect(posted).not.toBeNull()
  expect(posted!.clientId).toMatch(V4)
  expect(posted!.metrics.socket_subscriptions).toEqual({ count: 1, total: 1, max: 1 })
  stop()
})

test("startClientPerformance still does not throw with no crypto at all", () => {
  stubWindow()
  Object.defineProperty(globalThis, "crypto", { configurable: true, writable: true, value: undefined })
  let stop: (() => void) | undefined
  expect(() => { stop = startClientPerformance(() => ({})) }).not.toThrow()
  stop?.()
})
