import path from "node:path"
import { Effect, FileSystem, Option, Schema } from "effect"
import { getCloudFilePath } from "../shared/branding"
import { Machine } from "./platform/machine"
import { runCommand } from "./process-utils"

export function getMachineNameOverridePath(homeDir: string) {
  return path.join(homeDir, ".kanna", "machine-name")
}

/** The fields of cloud.json this module reads; the rest belongs to cloud/identity. */
const DevboxIdentity = Schema.fromJsonString(Schema.Struct({
  mode: Schema.optional(Schema.Unknown),
  subdomain: Schema.optional(Schema.Unknown),
}))

/** A file's text, or none when it is missing or unreadable. */
const readOptionalFile = Effect.fn("MachineName.readOptionalFile")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", () => Effect.succeedNone),
  )
})

/**
 * ~/.kanna/machine-name — explicit display-name override (first non-empty
 * line). Written by environments whose hostname is meaningless, e.g. deploy
 * previews name themselves after the ref they serve; users can set it too.
 */
export const readMachineNameOverride = Effect.fn("MachineName.readOverride")(function* (
  overridePath?: string,
) {
  const text = yield* readOptionalFile(overridePath ?? getMachineNameOverridePath((yield* Machine).homeDirectory))
  const firstLine = Option.isSome(text) ? text.value.split("\n")[0]?.trim() ?? "" : ""
  return firstLine ? firstLine.slice(0, 80) : null
})

/**
 * Dev-boxes (direct-mode cloud identities) are named by the subdomain the
 * user picked at creation — the sandbox's own hostname is a random id.
 */
export const readDevboxSubdomain = Effect.fn("MachineName.readDevboxSubdomain")(function* (
  identityPath?: string,
) {
  const text = yield* readOptionalFile(identityPath ?? getCloudFilePath((yield* Machine).homeDirectory))
  if (Option.isNone(text)) return null
  const identity = Schema.decodeUnknownOption(DevboxIdentity)(text.value)
  if (Option.isNone(identity) || identity.value.mode !== "direct") return null
  const subdomain = typeof identity.value.subdomain === "string" ? identity.value.subdomain.trim() : ""
  return subdomain || null
})

/** `scutil --get ComputerName`: the name the user gave this Mac. */
const readComputerName = Effect.fn("MachineName.readComputerName")(function* () {
  return yield* runCommand(["scutil", "--get", "ComputerName"], { stdout: true }).pipe(
    Effect.map((output) => (output.exitCode === 0 ? output.stdout.trim() : "") || null),
    Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Effect.succeed(null)),
  )
})

export const getMachineDisplayName = Effect.fn("MachineName.getDisplayName")(function* (
  identityPath?: string,
  overridePath?: string,
) {
  const override = yield* readMachineNameOverride(overridePath)
  if (override) {
    return override
  }

  const devboxSubdomain = yield* readDevboxSubdomain(identityPath)
  if (devboxSubdomain) {
    return devboxSubdomain
  }

  const machine = yield* Machine
  if (machine.platform === "darwin") {
    const computerName = yield* readComputerName()
    if (computerName) {
      return computerName
    }
  }

  const rawHostname = machine.hostname().trim()
  return rawHostname.replace(/\.local$|\.lan$/i, "") || "This Machine"
})
