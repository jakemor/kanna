import { afterEach, expect, test } from "bun:test"
import { generateUUID } from "./utils"

/**
 * `crypto.randomUUID` is secure-context only, so it is `undefined` over plain
 * http on a LAN/Tailscale hostname. `generateUUID` is the fallback every client
 * call site uses in that case, and it should draw from `crypto.getRandomValues`
 * (which is NOT secure-context gated) rather than `Math.random`.
 */

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const realCrypto = globalThis.crypto

afterEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: realCrypto, configurable: true, writable: true, enumerable: true,
  })
})

/** Drops the secure-context-only API, leaving `getRandomValues` in place. */
function useInsecureContext(overrides: Record<string, unknown> = {}) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    writable: true,
    value: {
      getRandomValues: (array: Uint8Array) => realCrypto.getRandomValues(array),
      ...overrides,
    },
  })
}

test("falls back to a valid v4 UUID when crypto.randomUUID is missing", () => {
  useInsecureContext()
  expect(typeof crypto.randomUUID).toBe("undefined")

  const ids = new Set<string>()
  for (let i = 0; i < 1000; i++) {
    const id = generateUUID()
    expect(id).toMatch(V4)
    ids.add(id)
  }
  expect(ids.size).toBe(1000)
})

test("draws the fallback bytes from crypto.getRandomValues, not Math.random", () => {
  let calls = 0
  useInsecureContext({
    getRandomValues: (array: Uint8Array) => { calls += 1; return realCrypto.getRandomValues(array) },
  })
  const realRandom = Math.random
  Math.random = () => { throw new Error("Math.random must not be used") }
  try {
    expect(generateUUID()).toMatch(V4)
  } finally {
    Math.random = realRandom
  }
  expect(calls).toBeGreaterThan(0)
})

test("produces a valid v4 UUID with no crypto at all", () => {
  Object.defineProperty(globalThis, "crypto", { configurable: true, writable: true, value: undefined })
  const ids = new Set<string>()
  for (let i = 0; i < 1000; i++) {
    const id = generateUUID()
    expect(id).toMatch(V4)
    ids.add(id)
  }
  expect(ids.size).toBe(1000)
})

test("uses crypto.randomUUID when it is available", () => {
  const spy = () => "11111111-2222-4333-8444-555555555555"
  Object.defineProperty(globalThis, "crypto", {
    configurable: true, writable: true, value: { randomUUID: spy, getRandomValues: realCrypto.getRandomValues },
  })
  expect(generateUUID()).toBe("11111111-2222-4333-8444-555555555555")
})
