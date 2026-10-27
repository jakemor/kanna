/**
 * Secrets an agent asked the user for (`request_secrets`), stored in the
 * keychain of the machine running Kanna, one namespace per project.
 *
 * Values cross the wire once, client to server, in `secrets.submit` or
 * `secrets.set`, and nothing sends one back: the tool result, the transcript,
 * snapshots and `secrets.list` carry names only. An agent uses a value by name
 * through `kanna secret exec`, which puts it in a child process's environment.
 */

/** Environment-variable style, so a key is also the variable it becomes. */
export const SECRET_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/

/** Longest key. Keychain service names hold far more; this keeps rows readable. */
export const SECRET_KEY_MAX_LENGTH = 128

/** Longest value, in characters. A PEM private key is a few KB. */
export const SECRET_VALUE_MAX_LENGTH = 64 * 1024

/** Most fields one request can ask for. */
export const SECRET_REQUEST_MAX_FIELDS = 20

export function isSecretKey(key: string) {
  return key.length <= SECRET_KEY_MAX_LENGTH && SECRET_KEY_PATTERN.test(key)
}

/** One value the agent asks for. `secret` defaults to true and `optional` to false. */
export interface SecretFieldRequest {
  key: string
  label?: string
  description?: string
  /** Masked in the form. False for what is not sensitive: a client ID, a region. */
  secret?: boolean
  /** The user can skip it and still save the rest. */
  optional?: boolean
}

/** The `request_secrets` call's input, as the transcript keeps it. */
export interface RequestSecretsInput {
  reason: string
  fields: SecretFieldRequest[]
}

/**
 * What the agent gets back and the transcript keeps: names, never values.
 * `discarded` is the turn stopping while the form was open.
 */
export interface RequestSecretsToolResult {
  saved: string[]
  skipped: string[]
  cancelled?: boolean
  discarded?: boolean
}

export type SecretBackendKind = "keychain" | "libsecret" | "file"

export interface SecretSummary {
  key: string
  savedAt: number
  /** The chat whose request saved it. Absent when it was set from Settings. */
  chatId?: string
  /** That chat's title, when it still exists. */
  chatTitle?: string
}

export interface ProjectSecrets {
  projectId: string
  title: string
  localPath: string
  secrets: SecretSummary[]
}

/** `secrets.list`, and the reply to `secrets.set` and `secrets.delete`. */
export interface SecretsListResult {
  backend: SecretBackendKind
  /** Projects with at least one secret, by title. Keys sorted. */
  projects: ProjectSecrets[]
}
