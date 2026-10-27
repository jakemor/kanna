import { spawn } from "node:child_process"
import os from "node:os"
import process from "node:process"
import { CLI_COMMAND, getDataDir } from "../shared/branding"
import { isSecretKey } from "../shared/secrets"
import { SecretsService, resolveSecretsProject } from "./secrets"

/**
 * `kanna secret`: how an agent uses what `request_secrets` saved without
 * reading it. `exec` hands the values to a child process as environment
 * variables and prints nothing of them; `list` prints names.
 *
 * The project is the one whose folder the shell is in (`resolveSecretsProject`),
 * so an agent reaches its own project's secrets and no other's.
 */

const USAGE = [
  `Usage: ${CLI_COMMAND} secret exec KEY [KEY...] -- <command> [args...]`,
  `       ${CLI_COMMAND} secret list [--json]`,
  "",
  "exec  Run <command> with the named secrets of this folder's Kanna project",
  "      set as environment variables. Its exit code is passed through.",
  "list  Name the secrets saved for this folder's Kanna project.",
  "",
  "Agents get secrets with Kanna's request_secrets tool. Values are never printed.",
].join("\n")

export interface SecretCliDeps {
  cwd: string
  env: Record<string, string | undefined>
  stdout: (text: string) => void
  stderr: (text: string) => void
  service: SecretsService
  /** Runs the command with stdio passed through and resolves with its exit code. */
  run: (command: string, args: string[], env: Record<string, string | undefined>) => Promise<number>
}

export async function runSecretCli(argv: string[], deps: SecretCliDeps): Promise<number> {
  const [action, ...rest] = argv
  const fail = (message: string, code = 1) => {
    deps.stderr(`${CLI_COMMAND} secret: ${message}\n`)
    return code
  }

  if (!action || action === "--help" || action === "-h" || action === "help") {
    ;(action ? deps.stdout : deps.stderr)(`${USAGE}\n`)
    return action ? 0 : 2
  }

  const project = resolveSecretsProject(await deps.service.listAll(), deps.cwd)

  if (action === "list") {
    const json = rest.includes("--json")
    const unknown = rest.find((arg) => arg !== "--json")
    if (unknown) return fail(`unexpected argument ${unknown}\n${USAGE}`, 2)
    const secrets = project ? await deps.service.list(project.projectId) : []
    if (json) {
      deps.stdout(`${JSON.stringify({ projectId: project?.projectId ?? null, secrets })}\n`)
    } else if (secrets.length === 0) {
      deps.stderr(`No Kanna secrets are saved for ${deps.cwd}. Ask the user for them with request_secrets.\n`)
    } else {
      for (const secret of secrets) deps.stdout(`${secret.key}\tsaved ${new Date(secret.savedAt).toISOString()}\n`)
    }
    return 0
  }

  if (action === "exec") {
    const separator = rest.indexOf("--")
    if (separator === -1) return fail(`exec needs -- before the command\n${USAGE}`, 2)
    const keys = rest.slice(0, separator)
    const [command, ...args] = rest.slice(separator + 1)
    if (keys.length === 0) return fail("name at least one secret before --", 2)
    if (!command) return fail("no command after --", 2)
    const invalid = keys.find((key) => !isSecretKey(key))
    if (invalid) return fail(`${JSON.stringify(invalid.slice(0, 64))} is not a secret name (A-Z, 0-9 and _, starting with a letter)`, 2)
    if (!project) return fail(`no Kanna secrets are saved for ${deps.cwd}. Run this from the project's folder, or ask the user with request_secrets.`)

    let values: Record<string, string>
    try {
      values = await deps.service.read(project.projectId, [...new Set(keys)])
    } catch (error) {
      return fail(`${error instanceof Error ? error.message : String(error)}. Ask the user for it with request_secrets.`)
    }
    try {
      return await deps.run(command, args, { ...deps.env, ...values })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return fail(code === "ENOENT" ? `command not found: ${command}` : `could not run ${command}`, code === "ENOENT" ? 127 : 126)
    }
  }

  return fail(`unknown command ${action}\n${USAGE}`, 2)
}

/** Spawns with stdio inherited and hands SIGTERM and SIGHUP on; Ctrl-C reaches the child from the terminal itself. */
export function runInherited(command: string, args: string[], env: Record<string, string | undefined>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env })
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
    const handlers = (["SIGTERM", "SIGHUP", "SIGINT"] as const).map((signal) => {
      // SIGINT is caught only so this process outlives the child and reports its code.
      const handler = signal === "SIGINT" ? () => {} : forward(signal)
      process.on(signal, handler)
      return [signal, handler] as const
    })
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler)
    }
    child.once("error", (error) => {
      cleanup()
      reject(error)
    })
    child.once("exit", (code, signal) => {
      cleanup()
      resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1))
    })
  })
}

export async function runSecretCommand(argv: string[]): Promise<number> {
  return runSecretCli(argv, {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    service: new SecretsService({ dataDir: getDataDir(os.homedir()) }),
    run: runInherited,
  })
}
