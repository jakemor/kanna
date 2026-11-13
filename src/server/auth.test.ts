import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAuthManager, createLoginThrottle, loginClientKey } from "./auth"
import { persistProjectUpload } from "./uploads"
import { startTestServer } from "./__fixtures__/test-server"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function startPasswordServer(options: { trustProxy?: boolean; port?: number } = {}) {
  const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-auth-test-"))
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-auth-data-"))
  // A stand-in for the built client, so the shell is served without a prior
  // `bun run build` (a fresh checkout has no dist/client and answers 503).
  const clientDistDir = await mkdtemp(path.join(tmpdir(), "kanna-auth-client-"))
  await writeFile(path.join(clientDistDir, "index.html"), '<!doctype html><div id="root"></div>')
  tempDirs.push(projectDir)
  tempDirs.push(dataDir)
  tempDirs.push(clientDistDir)
  const server = await startTestServer({
    dataDir,
    clientDistDir,
    port: options.port ?? 4320,
    strictPort: true,
    password: "secret",
    trustProxy: options.trustProxy ?? false,
  })
  const project = await server.store.openProject(projectDir, "Project")
  return { server, projectDir, project }
}

function extractCookie(response: Response) {
  const header = response.headers.get("set-cookie")
  expect(header).toBeTruthy()
  return header!.split(";", 1)[0]
}

describe("password auth", () => {
  test("serves the app shell to unauthenticated browser requests", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/chat/demo`, { headers: { Accept: "text/html" } })
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(response.headers.get("origin-agent-cluster")).toBe("?1")
      expect(await response.text()).toContain('id="root"')
    } finally {
      await server.stop()
    }
  })

  test("serves health checks without authentication", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/health`, { redirect: "manual" })
      expect(response.status).toBe(200)
      expect(response.headers.get("origin-agent-cluster")).toBe("?1")
    } finally {
      await server.stop()
    }
  })

  test("blocks unauthenticated api requests", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/api/projects/project-1/uploads`, { redirect: "manual" })
      expect(response.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  test("redirects /auth/login back into the app", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login?next=%2Fchat%2Fdemo`, { redirect: "manual" })
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe(`http://localhost:${server.port}/chat/demo`)
    } finally {
      await server.stop()
    }
  })

  test("sets a session cookie after a successful login", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })

      expect(response.status).toBe(200)
      expect(extractCookie(response)).toContain("kanna_session=")
    } finally {
      await server.stop()
    }
  })

  test("rejects an invalid password", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "wrong", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })

      expect(response.status).toBe(401)
      expect(response.headers.get("set-cookie")).toBeNull()
    } finally {
      await server.stop()
    }
  })

  test("rejects cross-origin login attempts", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil.test",
        },
      })

      expect(response.status).toBe(403)
    } finally {
      await server.stop()
    }
  })

  test("allows authenticated access to protected routes", async () => {
    const { server, project, projectDir } = await startPasswordServer()

    try {
      const attachment = await persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "hello.txt",
        bytes: new TextEncoder().encode("hello from upload"),
        fallbackMimeType: "text/plain",
      })

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })
      const cookie = extractCookie(loginResponse)

      const healthResponse = await fetch(`http://localhost:${server.port}/health`, {
        headers: {
          Cookie: cookie,
        },
      })
      expect(healthResponse.status).toBe(200)

      const contentResponse = await fetch(`http://localhost:${server.port}${attachment.contentUrl}`, {
        headers: {
          Cookie: cookie,
        },
      })
      expect(contentResponse.status).toBe(200)
      expect(await contentResponse.text()).toBe("hello from upload")
    } finally {
      await server.stop()
    }
  })

  test("ignores forwarded proto when trustProxy is off", async () => {
    const { server } = await startPasswordServer({ port: 54321 })

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login?next=%2F`, {
        redirect: "manual",
        headers: {
          "X-Forwarded-Proto": "https",
        },
      })
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe(`http://localhost:${server.port}/`)

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.test",
          "X-Forwarded-Proto": "https",
        },
      })
      expect(loginResponse.status).toBe(403)

      const goodLoginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
          "X-Forwarded-Proto": "https",
        },
      })
      expect(goodLoginResponse.status).toBe(200)
      const cookieHeader = goodLoginResponse.headers.get("set-cookie") ?? ""
      expect(cookieHeader).not.toContain("Secure")
    } finally {
      await server.stop()
    }
  })

  test("honors forwarded proto when trustProxy is on", async () => {
    const { server } = await startPasswordServer({ port: 54322, trustProxy: true })

    try {
      const redirect = await fetch(`http://localhost:${server.port}/auth/login?next=%2F`, {
        redirect: "manual",
        headers: {
          "X-Forwarded-Proto": "https",
        },
      })
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get("location")).toBe(`https://localhost:${server.port}/`)

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `https://localhost:${server.port}`,
          "X-Forwarded-Proto": "https",
        },
      })
      expect(loginResponse.status).toBe(200)
      expect(loginResponse.headers.get("set-cookie") ?? "").toContain("Secure")

      const evilResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })
      expect(evilResponse.status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  test("ignores invalid forwarded proto values", async () => {
    const { server } = await startPasswordServer({ port: 54323, trustProxy: true })

    try {
      const redirect = await fetch(`http://localhost:${server.port}/auth/login?next=%2F`, {
        redirect: "manual",
        headers: {
          "X-Forwarded-Proto": "ftp",
        },
      })
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get("location")).toBe(`http://localhost:${server.port}/`)

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
          "X-Forwarded-Proto": "ftp",
        },
      })
      expect(loginResponse.status).toBe(200)
      expect(loginResponse.headers.get("set-cookie") ?? "").not.toContain("Secure")
    } finally {
      await server.stop()
    }
  })

  test("clears the session cookie on logout", async () => {
    const { server } = await startPasswordServer()

    try {
      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })
      const cookie = extractCookie(loginResponse)

      const logoutResponse = await fetch(`http://localhost:${server.port}/auth/logout`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: `http://localhost:${server.port}`,
        },
      })

      expect(logoutResponse.status).toBe(200)
      expect(logoutResponse.headers.get("set-cookie")).toContain("Max-Age=0")

      const healthResponse = await fetch(`http://localhost:${server.port}/health`, {
        headers: {
          Cookie: cookie,
        },
      })
      expect(healthResponse.status).toBe(200)
    } finally {
      await server.stop()
    }
  })
})

describe("wrong-password backoff", () => {
  const login = (auth: ReturnType<typeof createAuthManager>, password: string, client: string) =>
    auth.handleLogin(new Request("http://localhost:3210/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }), "/", client)

  test("the first misses are free, then each one waits longer, up to half a minute", () => {
    let time = 1_000_000
    const throttle = createLoginThrottle(() => time)
    const waits: number[] = []
    for (let attempt = 0; attempt < 14; attempt += 1) {
      throttle.recordFailure("203.0.113.9")
      waits.push(throttle.waitMs("203.0.113.9"))
      time += waits.at(-1)!
    }
    expect(waits).toEqual([0, 0, 0, 0, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000])
  })

  test("300 wrong guesses in a row get five looks, and the rest are turned away unread", async () => {
    let time = 1_000_000
    const auth = createAuthManager("secret", { now: () => time })
    const statuses = new Map<number, number>()
    for (let attempt = 0; attempt < 300; attempt += 1) {
      // The 300th guess is the right one, and it is still not looked at.
      const response = await login(auth, attempt === 299 ? "secret" : `guess-${attempt}`, "203.0.113.9")
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1)
      time += 1
    }
    expect([...statuses]).toEqual([[401, 5], [429, 295]])
  })

  test("a refused guess says how long to wait", async () => {
    const time = 1_000_000
    const auth = createAuthManager("secret", { now: () => time })
    for (let attempt = 0; attempt < 5; attempt += 1) await login(auth, "wrong", "203.0.113.9")
    const response = await login(auth, "wrong", "203.0.113.9")
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("1")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(await response.json()).toEqual({ error: "Too many wrong passwords. Try again in 1 second.", retryAfterSeconds: 1 })
  })

  test("the owner is in again once the wait is over, and never waits more than half a minute", async () => {
    let time = 1_000_000
    const auth = createAuthManager("secret", { now: () => time })
    // Someone hammers from the owner's own address for ten minutes.
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await login(auth, "wrong", "203.0.113.9")
      time += 1_000
    }
    expect((await login(auth, "secret", "203.0.113.9")).status).toBe(429)
    time += 30_000
    const response = await login(auth, "secret", "203.0.113.9")
    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toContain("kanna_session=")
  })

  test("one address's misses do not slow another", async () => {
    const time = 1_000_000
    const auth = createAuthManager("secret", { now: () => time })
    for (let attempt = 0; attempt < 50; attempt += 1) await login(auth, "wrong", "203.0.113.9")
    expect((await login(auth, "wrong", "203.0.113.9")).status).toBe(429)
    expect((await login(auth, "secret", "198.51.100.7")).status).toBe(200)
  })

  test("a right password clears the count, and so does a quiet quarter of an hour", async () => {
    let time = 1_000_000
    const auth = createAuthManager("secret", { now: () => time })
    for (let attempt = 0; attempt < 4; attempt += 1) expect((await login(auth, "wrong", "c")).status).toBe(401)
    expect((await login(auth, "secret", "c")).status).toBe(200)
    for (let attempt = 0; attempt < 4; attempt += 1) expect((await login(auth, "wrong", "c")).status).toBe(401)
    time += 15 * 60_000
    for (let attempt = 0; attempt < 4; attempt += 1) expect((await login(auth, "wrong", "c")).status).toBe(401)
  })

  test("an IPv6 customer is one client, whichever of its addresses it uses", () => {
    expect(loginClientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(loginClientKey("2001:db8:1:2::1"))
    expect(loginClientKey("2001:db8:1:2::1")).not.toBe(loginClientKey("2001:db8:1:3::1"))
    expect(loginClientKey("2001:0db8:0001:0002::1")).toBe(loginClientKey("2001:db8:1:2::1"))
    expect(loginClientKey("::ffff:127.0.0.1")).toBe("127.0.0.1")
    expect(loginClientKey("::1")).toBe(loginClientKey("0:0:0:0:0:0:0:1"))
    expect(loginClientKey("203.0.113.9")).toBe("203.0.113.9")
    expect(loginClientKey(null)).toBe("unknown")
  })

  test("the memory of who missed is bounded", () => {
    const throttle = createLoginThrottle(() => 1_000_000)
    for (let client = 0; client < 10_050; client += 1) {
      for (let attempt = 0; attempt < 6; attempt += 1) throttle.recordFailure(`client-${client}`)
    }
    // The oldest were dropped to make room; the newest are still waiting.
    expect(throttle.waitMs("client-0")).toBe(0)
    expect(throttle.waitMs("client-10049")).toBeGreaterThan(0)
  })
})
