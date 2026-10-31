import { spawn } from "node:child_process"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SecretBackendKind } from "../shared/secrets"

/**
 * Where secret values live: the OS keychain where there is one, otherwise an
 * encrypted file. One item per project and key. Names and metadata live in
 * `secrets.ts`; nothing here knows about chats.
 */
export interface SecretStore {
  readonly kind: SecretBackendKind | "memory"
  set(projectId: string, key: string, value: string): Promise<void>
  get(projectId: string, key: string): Promise<string | null>
  delete(projectId: string, key: string): Promise<void>
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs a command with `stdin` piped in. Values only ever travel through `stdin`. */
export type CommandRunner = (command: string, args: string[], stdin?: string) => Promise<CommandResult>

export const runCommand: CommandRunner = (command, args, stdin) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
  child.on("error", reject)
  child.on("close", (code) => resolve({
    code: code ?? 1,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  }))
  child.stdin.end(stdin ?? "")
})

/** Project ids are UUIDs; anything else could break out of a quoted `security -i` argument. */
function assertSafeName(projectId: string, key: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error("Invalid project id")
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("Invalid secret key")
}

function osAccount() {
  try {
    const name = os.userInfo().username
    // Quoted into a `security -i` line, so no quotes or backslashes.
    if (/^[A-Za-z0-9._@ -]+$/.test(name)) return name
  } catch {
    // No passwd entry (some containers).
  }
  return "kanna"
}

/** Bytes per keychain item. `security -i` reads a line of about 4 KB and cuts a longer one short, saving what fit. */
export const KEYCHAIN_CHUNK_BYTES = 1800
const CHUNK_COMMENT = /^kanna-chunks:(\d+)$/
const NOT_FOUND = 44

/**
 * The login keychain, through `/usr/bin/security`: a generic password per
 * key, service `<prefix>:<projectId>:<KEY>`, account the OS user.
 *
 * Values are written with `security -i`, which reads its commands from
 * stdin, as `-X <hex>`: nothing of the value is in an argv that `ps` shows,
 * and hex needs no quoting whatever the value holds. `security` echoes a
 * line it can't run, hex and all, so its stderr is never passed on.
 *
 * Its line limit makes a value over `KEYCHAIN_CHUNK_BYTES` several items:
 * the first is the service itself, with comment `kanna-chunks:N`, and the
 * rest are `<service>#2` to `#N`. A PEM key or a service-account JSON is two
 * or three.
 *
 * The item trusts `security`, so reads don't prompt. That also means any
 * process running as this user can read it: the per-project namespace keeps
 * agents from mixing projects up, it is not a wall between them.
 */
export class KeychainSecretStore implements SecretStore {
  readonly kind = "keychain" as const
  private readonly account = osAccount()

  constructor(private readonly options: { servicePrefix?: string; run?: CommandRunner } = {}) {}

  private service(projectId: string, key: string) {
    assertSafeName(projectId, key)
    return `${this.options.servicePrefix ?? "kanna"}:${projectId}:${key}`
  }

  private run(args: string[], stdin?: string) {
    return (this.options.run ?? runCommand)("security", args, stdin)
  }

  /** The item's data, and how many items the value spans; null when there is none. */
  private async readItem(service: string): Promise<{ data: Buffer; chunks: number } | null> {
    const result = await this.run(["find-generic-password", "-a", this.account, "-s", service, "-g"])
    if (result.code === NOT_FOUND) return null
    if (result.code !== 0) throw new Error("Could not read from the keychain")
    const comment = /"icmt"<blob>="([^"]*)"/.exec(result.stdout)?.[1] ?? ""
    const chunks = Number(CHUNK_COMMENT.exec(comment)?.[1] ?? 1)
    return { data: parseSecurityPassword(result.stderr), chunks }
  }

  async set(projectId: string, key: string, value: string) {
    const service = this.service(projectId, key)
    // `security` refuses `-X ""`, and an empty secret is a skipped one.
    if (value === "") throw new Error("Secret value is empty")
    const bytes = Buffer.from(value, "utf8")
    const lines: string[] = []
    const count = Math.ceil(bytes.length / KEYCHAIN_CHUNK_BYTES)
    for (let index = 0; index < count; index += 1) {
      const chunk = bytes.subarray(index * KEYCHAIN_CHUNK_BYTES, (index + 1) * KEYCHAIN_CHUNK_BYTES)
      const name = index === 0 ? service : `${service}#${index + 1}`
      const comment = index === 0 && count > 1 ? ` -j "kanna-chunks:${count}"` : ""
      lines.push(`add-generic-password -U -a "${this.account}" -s "${name}"${comment} -X ${chunk.toString("hex")}`)
    }
    // Replaced whole, so a shorter value leaves no stale chunks and the
    // head's chunk count is the new one.
    await this.delete(projectId, key)
    const result = await this.run(["-i"], `${lines.join("\n")}\n`)
    if (result.code !== 0) {
      await this.delete(projectId, key).catch(() => {})
      throw new Error("Could not save to the keychain")
    }
  }

  async get(projectId: string, key: string) {
    const service = this.service(projectId, key)
    const head = await this.readItem(service)
    if (!head) return null
    const parts = [head.data]
    for (let index = 2; index <= head.chunks; index += 1) {
      const part = await this.readItem(`${service}#${index}`)
      if (!part) throw new Error(`Part of ${key} is missing from the keychain`)
      parts.push(part.data)
    }
    return Buffer.concat(parts).toString("utf8")
  }

  async delete(projectId: string, key: string) {
    const service = this.service(projectId, key)
    const head = await this.readItem(service).catch(() => null)
    const chunks = head?.chunks ?? 1
    await this.run(["delete-generic-password", "-a", this.account, "-s", service])
    for (let index = 2; index <= chunks; index += 1) {
      await this.run(["delete-generic-password", "-a", this.account, "-s", `${service}#${index}`])
    }
  }
}

/**
 * `security find-generic-password -g` writes the data to stderr as
 * `password: "text"` when it is printable and `password: 0x<HEX>  "..."`
 * when it is not (a newline, a backslash, anything past ASCII). The quoted
 * form is raw, quotes included, so it runs to the line's last quote.
 */
export function parseSecurityPassword(stderr: string): Buffer {
  const line = stderr.split("\n").find((candidate) => candidate.startsWith("password:"))
  if (line === undefined) throw new Error("Could not read from the keychain")
  const rest = line.slice("password:".length).trim()
  if (rest === "") return Buffer.alloc(0)
  const hex = /^0x([0-9A-Fa-f]*)/.exec(rest)
  if (hex) return Buffer.from(hex[1]!, "hex")
  const first = rest.indexOf("\"")
  const last = rest.lastIndexOf("\"")
  if (first === -1 || last <= first) throw new Error("Could not read from the keychain")
  return Buffer.from(rest.slice(first + 1, last), "utf8")
}

/**
 * libsecret's `secret-tool`, which reads the value to store from stdin and
 * writes a looked-up one to stdout. Attributes are the keychain store's
 * service and account.
 */
export class LibsecretSecretStore implements SecretStore {
  readonly kind = "libsecret" as const
  private readonly account = osAccount()

  constructor(private readonly options: { servicePrefix?: string; run?: CommandRunner } = {}) {}

  private attributes(projectId: string, key: string) {
    assertSafeName(projectId, key)
    return ["service", `${this.options.servicePrefix ?? "kanna"}:${projectId}:${key}`, "account", this.account]
  }

  private run(args: string[], stdin?: string) {
    return (this.options.run ?? runCommand)("secret-tool", args, stdin)
  }

  async set(projectId: string, key: string, value: string) {
    const result = await this.run(["store", `--label=Kanna ${key}`, ...this.attributes(projectId, key)], value)
    if (result.code !== 0) throw new Error("Could not save to the secret service")
  }

  async get(projectId: string, key: string) {
    const result = await this.run(["lookup", ...this.attributes(projectId, key)])
    // `lookup` exits 1 with no output when there is no such item.
    if (result.code !== 0) {
      if (result.stdout === "" && result.stderr.trim() === "") return null
      throw new Error("Could not read from the secret service")
    }
    return result.stdout
  }

  async delete(projectId: string, key: string) {
    await this.run(["clear", ...this.attributes(projectId, key)])
  }
}

interface EncryptedEntry {
  iv: string
  tag: string
  data: string
}

interface EncryptedFile {
  version: 1
  entries: Record<string, EncryptedEntry>
}

/**
 * The fallback where there's no keychain to use (Linux without a secret
 * service, Windows): AES-256-GCM, one entry per project and key, in
 * `<dir>/store.json`, under a random key in `<dir>/key`. Both files are 0600
 * and the folder 0700. The entry's id is the GCM additional data, so an
 * entry copied to another key or project fails to decrypt.
 *
 * Only as safe as the account: anyone who can read the files can read the
 * values. It keeps them out of the transcript and out of plain sight.
 */
export class EncryptedFileSecretStore implements SecretStore {
  readonly kind = "file" as const
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly dir: string) {}

  private get storePath() {
    return path.join(this.dir, "store.json")
  }

  private async key(create: boolean): Promise<Buffer | null> {
    const keyPath = path.join(this.dir, "key")
    try {
      const key = await readFile(keyPath)
      if (key.length !== 32) throw new Error("The secrets key file is damaged")
      return key
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      if (!create) return null
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700).catch(() => {})
    const key = randomBytes(32)
    try {
      // `wx`: two first writes race, and the loser reads the winner's key.
      const handle = await open(keyPath, "wx", 0o600)
      await handle.writeFile(key)
      await handle.close()
      return key
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return this.key(false)
      throw error
    }
  }

  private async read(): Promise<EncryptedFile> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as EncryptedFile
      return parsed?.version === 1 && parsed.entries ? parsed : { version: 1, entries: {} }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} }
      throw error
    }
  }

  private async write(file: EncryptedFile) {
    const temp = `${this.storePath}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(file), { mode: 0o600 })
    await rename(temp, this.storePath)
  }

  private update(change: (file: EncryptedFile, key: Buffer) => void) {
    const next = this.writes.then(async () => {
      const key = await this.key(true)
      const file = await this.read()
      change(file, key!)
      await this.write(file)
    })
    this.writes = next.catch(() => {})
    return next
  }

  async set(projectId: string, key: string, value: string) {
    assertSafeName(projectId, key)
    const id = `${projectId}:${key}`
    await this.update((file, secretKey) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", secretKey, iv)
      cipher.setAAD(Buffer.from(id, "utf8"))
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
      file.entries[id] = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }
    })
  }

  async get(projectId: string, key: string) {
    assertSafeName(projectId, key)
    const id = `${projectId}:${key}`
    const entry = (await this.read()).entries[id]
    if (!entry) return null
    const secretKey = await this.key(false)
    if (!secretKey) throw new Error("The secrets key file is missing")
    const decipher = createDecipheriv("aes-256-gcm", secretKey, Buffer.from(entry.iv, "base64"))
    decipher.setAAD(Buffer.from(id, "utf8"))
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"))
    return Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]).toString("utf8")
  }

  async delete(projectId: string, key: string) {
    assertSafeName(projectId, key)
    await this.update((file) => {
      delete file.entries[`${projectId}:${key}`]
    })
  }
}

/** For tests: values in a map, never on disk. */
export class MemorySecretStore implements SecretStore {
  readonly kind = "memory" as const
  readonly values = new Map<string, string>()

  async set(projectId: string, key: string, value: string) {
    assertSafeName(projectId, key)
    this.values.set(`${projectId}:${key}`, value)
  }

  async get(projectId: string, key: string) {
    return this.values.get(`${projectId}:${key}`) ?? null
  }

  async delete(projectId: string, key: string) {
    this.values.delete(`${projectId}:${key}`)
  }
}

/** The backend this machine should use, before anything is stored. */
export function detectSecretBackend(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  which: (command: string) => string | null = (command) => Bun.which(command),
): SecretBackendKind {
  if (platform === "darwin" && which("security")) return "keychain"
  // secret-tool needs a session bus to reach the secret service; a headless
  // box has the binary and no bus.
  if (platform === "linux" && which("secret-tool") && env.DBUS_SESSION_BUS_ADDRESS) return "libsecret"
  return "file"
}

export function createSecretStore(backend: SecretBackendKind, dataDir: string): SecretStore {
  switch (backend) {
    case "keychain":
      return new KeychainSecretStore()
    case "libsecret":
      return new LibsecretSecretStore()
    case "file":
      return new EncryptedFileSecretStore(path.join(dataDir, "secrets"))
  }
}
