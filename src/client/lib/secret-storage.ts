import type { SecretBackendKind, SecretsListResult } from "../../shared/secrets"

/*
 * Where secret values are kept, in words, by the backend the server stores
 * to (`SecretsListResult.backend`). Worded as the iOS app's
 * `SecretsList.storageDescription`, so both clients say the same thing. A
 * Kanna on Linux has no Keychain, so no copy may assume one.
 */

/** The request card's one line: where the values go, and what the agent sees. */
export function secretStorageNote(backend: SecretBackendKind | null): string {
  switch (backend) {
    case "keychain": return "Saved to this Mac's Keychain. The agent sees only the names."
    case "libsecret": return "Saved to this computer's keyring. The agent sees only the names."
    case "file": return "Saved to a file only your user can read. The agent sees only the names."
    default: return "Saved on this computer. The agent sees only the names."
  }
}

/** Settings' footer. */
export function secretStorageDescription(backend: SecretBackendKind | null): string {
  switch (backend) {
    case "keychain": return "Stored in this Mac's Keychain. Agents get the names only, and use the values through kanna secret exec."
    case "libsecret": return "Stored in this computer's keyring (Secret Service). Agents get the names only, and use the values through kanna secret exec."
    case "file": return "Stored in a file on this computer that only your user can read. Agents get the names only, and use the values through kanna secret exec."
    default: return "Stored on this computer. Agents get the names only, and use the values through kanna secret exec."
  }
}

type SecretsCommand = (command: { type: "secrets.list" }) => Promise<SecretsListResult>

// The backend can't change while a server runs, so one answer per socket
// does for every card it draws.
const backends = new WeakMap<object, Promise<SecretBackendKind | null>>()

/** The server's backend, asked once per socket. Null when it can't be told. */
export function loadSecretBackend(socket: object, command: SecretsCommand): Promise<SecretBackendKind | null> {
  let backend = backends.get(socket)
  if (!backend) {
    backend = command({ type: "secrets.list" }).then((list) => list.backend, () => {
      // A failed ask isn't remembered: the next card asks again.
      backends.delete(socket)
      return null
    })
    backends.set(socket, backend)
  }
  return backend
}
