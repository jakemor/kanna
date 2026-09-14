import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createApiKeyVerifier,
  extractApiKey,
  parseApiKeyFile,
  parseApiKeyList,
  readApiKeyFile,
} from "./keys"

describe("parseApiKeyList", () => {
  test("splits on commas and trims", () => {
    expect(parseApiKeyList("a, b ,c")).toEqual(["a", "b", "c"])
  })

  test("drops empties and duplicates", () => {
    expect(parseApiKeyList("a,,a, ,b")).toEqual(["a", "b"])
  })

  test("returns nothing for a blank value", () => {
    expect(parseApiKeyList("   ")).toEqual([])
  })

  test("rejects a key past the length cap", () => {
    expect(parseApiKeyList("x".repeat(513))).toEqual([])
    expect(parseApiKeyList("x".repeat(512))).toHaveLength(1)
  })
})

describe("parseApiKeyFile", () => {
  test("reads one key per line", () => {
    expect(parseApiKeyFile("alpha\nbravo\ncharlie")).toEqual(["alpha", "bravo", "charlie"])
  })

  test("skips blank lines and comments", () => {
    expect(parseApiKeyFile("# for CI\nalpha\n\n  # laptop\nbravo\n")).toEqual(["alpha", "bravo"])
  })

  test("handles CRLF, since key files travel between machines", () => {
    expect(parseApiKeyFile("alpha\r\nbravo\r\n")).toEqual(["alpha", "bravo"])
  })

  test("dedupes", () => {
    expect(parseApiKeyFile("alpha\nalpha\n")).toEqual(["alpha"])
  })
})

describe("readApiKeyFile", () => {
  test("reads keys from disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-api-keys-"))
    try {
      const file = path.join(dir, "keys.txt")
      await writeFile(file, "alpha\n# note\nbravo\n", "utf8")
      expect(await readApiKeyFile(file)).toEqual(["alpha", "bravo"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("names the missing file so the operator can fix it", async () => {
    const missing = path.join(tmpdir(), `kanna-missing-${crypto.randomUUID()}.txt`)
    await expect(readApiKeyFile(missing)).rejects.toThrow(missing)
  })
})

describe("createApiKeyVerifier", () => {
  test("accepts a configured key and rejects everything else", () => {
    const verifier = createApiKeyVerifier(["alpha", "bravo"])
    expect(verifier.isValid("alpha")).toBe(true)
    expect(verifier.isValid("bravo")).toBe(true)
    expect(verifier.isValid("charlie")).toBe(false)
  })

  test("rejects a prefix of a real key", () => {
    const verifier = createApiKeyVerifier(["alphabet"])
    expect(verifier.isValid("alpha")).toBe(false)
    expect(verifier.isValid("alphabet")).toBe(true)
  })

  test("rejects empty and absent candidates", () => {
    const verifier = createApiKeyVerifier(["alpha"])
    expect(verifier.isValid(null)).toBe(false)
    expect(verifier.isValid(undefined)).toBe(false)
    expect(verifier.isValid("")).toBe(false)
  })

  test("an empty key list accepts nothing", () => {
    const verifier = createApiKeyVerifier([])
    expect(verifier.count).toBe(0)
    expect(verifier.isValid("alpha")).toBe(false)
  })

  test("counts distinct usable keys", () => {
    expect(createApiKeyVerifier(["alpha", "alpha", "", "bravo"]).count).toBe(2)
  })

  test("an oversized candidate is rejected without comparing", () => {
    expect(createApiKeyVerifier(["alpha"]).isValid("x".repeat(513))).toBe(false)
  })
})

describe("extractApiKey", () => {
  const request = (headers: Record<string, string>) => new Request("http://localhost/api/v1", { headers })

  test("reads a bearer token", () => {
    expect(extractApiKey(request({ authorization: "Bearer alpha" }))).toBe("alpha")
  })

  test("accepts any case for the scheme", () => {
    expect(extractApiKey(request({ authorization: "bearer alpha" }))).toBe("alpha")
  })

  test("reads X-Api-Key", () => {
    expect(extractApiKey(request({ "x-api-key": "alpha" }))).toBe("alpha")
  })

  test("prefers the Authorization header when both are present", () => {
    expect(extractApiKey(request({ authorization: "Bearer alpha", "x-api-key": "bravo" }))).toBe("alpha")
  })

  test("ignores other auth schemes", () => {
    expect(extractApiKey(request({ authorization: "Basic alpha" }))).toBeNull()
  })

  test("returns null with no credential", () => {
    expect(extractApiKey(request({}))).toBeNull()
  })
})
