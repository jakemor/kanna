import { existsSync, realpathSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  SECRET_VALUE_MAX_LENGTH,
  isSecretKey,
  type RequestSecretsToolResult,
  type SecretBackendKind,
  type SecretsListResult,
  type SecretFieldRequest,
  type SecretSummary,
} from "../shared/secrets"
import { createSecretStore, detectSecretBackend, type SecretStore } from "./secret-store"

/**
 * Secrets by project: the names and when each was saved, in
 * `<dataDir>/secrets.json`, with the values in a `SecretStore`.
 *
 * The index is what `kanna secret` reads to find the project a shell is in
 * and the backend the server stored to, so both agree without the server
 * running. It never holds a value.
 */
export const SECRETS_INDEX_FILE = "secrets.json"

interface SecretsIndex {
  version: 1
  backend: SecretBackendKind
  projects: Record<string, {
    localPath: string
    secrets: Record<string, { savedAt: number; chatId?: string }>
  }>
}

export interface SecretsProject {
  id: string
  localPath: string
}

export class SecretsService {
  private writes: Promise<unknown> = Promise.resolve()
  private storeInstance: SecretStore | null

  constructor(private readonly options: {
    dataDir: string
    /** Tests pass a fake. Otherwise the index's backend, or this machine's. */
    store?: SecretStore
    now?: () => number
  }) {
    this.storeInstance = options.store ?? null
  }

  private get indexPath() {
    return path.join(this.options.dataDir, SECRETS_INDEX_FILE)
  }

  async readIndex(): Promise<SecretsIndex> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as SecretsIndex
      if (parsed?.version === 1 && parsed.projects && typeof parsed.projects === "object") return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const store = this.options.store
    return { version: 1, backend: store && store.kind !== "memory" ? store.kind : detectSecretBackend(), projects: {} }
  }

  private async store() {
    this.storeInstance ??= createSecretStore((await this.readIndex()).backend, this.options.dataDir)
    return this.storeInstance
  }

  private updateIndex(change: (index: SecretsIndex) => void) {
    const next = this.writes.then(async () => {
      const index = await this.readIndex()
      change(index)
      await mkdir(this.options.dataDir, { recursive: true })
      const temp = `${this.indexPath}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.indexPath)
    })
    this.writes = next.catch(() => {})
    return next
  }

  async backend() {
    return (await this.readIndex()).backend
  }

  /** Every project with a secret, keyed by id, names sorted. */
  async listAll(): Promise<Array<{ projectId: string; localPath: string; secrets: SecretSummary[] }>> {
    const index = await this.readIndex()
    return Object.entries(index.projects).map(([projectId, project]) => ({
      projectId,
      localPath: project.localPath,
      secrets: summaries(project.secrets),
    }))
  }

  async list(projectId: string): Promise<SecretSummary[]> {
    const project = (await this.readIndex()).projects[projectId]
    return project ? summaries(project.secrets) : []
  }

  /** Validated before anything is stored; an error message never quotes a value. */
  async set(project: SecretsProject, key: string, value: string, meta: { chatId?: string } = {}) {
    await this.setMany(project, [[key, value]], meta)
  }

  private async setMany(project: SecretsProject, entries: Array<[string, string]>, meta: { chatId?: string }) {
    for (const [key, value] of entries) {
      if (!isSecretKey(key)) throw new Error(`Invalid secret name ${JSON.stringify(key.slice(0, 64))}`)
      if (value.length === 0) throw new Error(`${key} is empty`)
      if (value.length > SECRET_VALUE_MAX_LENGTH) throw new Error(`Secret value is too long (${key})`)
    }
    const store = await this.store()
    for (const [key, value] of entries) await store.set(project.id, key, value)
    const savedAt = this.options.now?.() ?? Date.now()
    await this.updateIndex((index) => {
      const record = index.projects[project.id] ??= { localPath: project.localPath, secrets: {} }
      record.localPath = project.localPath
      for (const [key] of entries) {
        record.secrets[key] = { savedAt, ...(meta.chatId ? { chatId: meta.chatId } : {}) }
      }
    })
  }

  async delete(projectId: string, key: string) {
    if (!isSecretKey(key)) throw new Error("Invalid secret name")
    await (await this.store()).delete(projectId, key)
    await this.updateIndex((index) => {
      const record = index.projects[projectId]
      if (!record) return
      delete record.secrets[key]
      if (Object.keys(record.secrets).length === 0) delete index.projects[projectId]
    })
  }

  /**
   * The user's answer to a `request_secrets` form. Every required field must
   * have a value and nothing outside the form is accepted; all of it is
   * checked before the first value is stored, so a refusal stores nothing.
   */
  async submitRequest(args: {
    project: SecretsProject
    chatId: string
    fields: SecretFieldRequest[]
    values?: Record<string, unknown>
    cancel?: boolean
  }): Promise<RequestSecretsToolResult> {
    const keys = args.fields.map((field) => field.key)
    if (args.cancel) return { saved: [], skipped: keys, cancelled: true }
    const values = args.values ?? {}
    if (typeof values !== "object" || Array.isArray(values)) throw new Error("Secret values must be an object")
    for (const key of Object.keys(values)) {
      if (!keys.includes(key)) throw new Error(`Unknown secret ${key.slice(0, 64)}`)
    }
    const entries: Array<[string, string]> = []
    const skipped: string[] = []
    for (const field of args.fields) {
      const raw = values[field.key]
      if (raw !== undefined && typeof raw !== "string") throw new Error(`${field.key} must be text`)
      // Pasting brings a trailing newline more often than a secret needs one.
      const value = (raw ?? "").trim()
      if (value) {
        entries.push([field.key, value])
      } else if (field.optional) {
        skipped.push(field.key)
      } else {
        throw new Error(`${field.key} is required`)
      }
    }
    if (entries.length > 0) await this.setMany(args.project, entries, { chatId: args.chatId })
    return { saved: entries.map(([key]) => key), skipped }
  }

  /**
   * The values, for `kanna secret exec` alone. Every name must be saved for
   * this project; there is no reaching into another one.
   */
  async read(projectId: string, keys: string[]): Promise<Record<string, string>> {
    const store = await this.store()
    const values: Record<string, string> = {}
    for (const key of keys) {
      if (!isSecretKey(key)) throw new Error(`Invalid secret name ${JSON.stringify(key.slice(0, 64))}`)
      const value = await store.get(projectId, key)
      if (value === null) throw new Error(`No secret named ${key} in this project`)
      values[key] = value
    }
    return values
  }
}

/**
 * `secrets.list` for Settings: the index with titles from the store. A
 * project removed from Kanna keeps its secrets and is listed by its folder,
 * so they can still be deleted.
 */
export async function buildSecretsList(
  service: SecretsService,
  lookup: {
    getProject: (projectId: string) => { title: string; sidebarTitle?: string; localPath: string } | null
    getChat: (chatId: string) => { title: string } | null
  },
): Promise<SecretsListResult> {
  const projects = (await service.listAll()).map(({ projectId, localPath, secrets }) => {
    const project = lookup.getProject(projectId)
    return {
      projectId,
      title: project?.sidebarTitle || project?.title || path.basename(localPath) || localPath,
      localPath: project?.localPath ?? localPath,
      secrets: secrets.map((secret) => {
        const chatTitle = secret.chatId ? lookup.getChat(secret.chatId)?.title : undefined
        return chatTitle ? { ...secret, chatTitle } : secret
      }),
    }
  })
  projects.sort((left, right) => left.title.localeCompare(right.title) || left.projectId.localeCompare(right.projectId))
  return { backend: await service.backend(), projects }
}

function summaries(secrets: Record<string, { savedAt: number; chatId?: string }>): SecretSummary[] {
  return Object.entries(secrets)
    .map(([key, meta]) => ({ key, savedAt: meta.savedAt, ...(meta.chatId ? { chatId: meta.chatId } : {}) }))
    .sort((left, right) => left.key.localeCompare(right.key))
}

function realpathOrSelf(target: string) {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * The project a shell is working in: the deepest project folder that is the
 * directory or holds it. Agents run in their project's folder, so this is
 * theirs, and only that project's secrets can be read from there.
 */
export function resolveSecretsProject(
  projects: Array<{ projectId: string; localPath: string }>,
  cwd: string,
): { projectId: string; localPath: string } | null {
  const here = realpathOrSelf(cwd)
  let best: { projectId: string; localPath: string; depth: number } | null = null
  for (const project of projects) {
    const root = realpathOrSelf(project.localPath)
    if (here !== root && !here.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)) continue
    if (!best || root.length > best.depth) best = { ...project, depth: root.length }
  }
  return best ? { projectId: best.projectId, localPath: best.localPath } : null
}

function shellQuote(value: string) {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * How an agent runs this Kanna's `kanna`: the Bun running the server and the
 * package's own `bin/kanna`. Whatever `kanna` is on PATH may be another
 * install, older and without `secret`, or a checkout pointed at another data
 * dir. The agent's shell inherits the server's environment, so the CLI reads
 * the same data dir. Falls back to `kanna` where the bin isn't found.
 */
export function kannaCliCommand(): string {
  const bin = fileURLToPath(new URL("../../bin/kanna", import.meta.url))
  if (!existsSync(bin)) return "kanna"
  return `${shellQuote(process.execPath)} ${shellQuote(bin)}`
}
