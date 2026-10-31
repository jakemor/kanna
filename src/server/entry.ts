import process from "node:process"
import { CLI_CHILD_MODE, CLI_CHILD_MODE_ENV_VAR } from "./restart"

/** The words `parseArgs` in cli-runtime.ts takes first. Any other word is a tool, or a mistake the tool CLI names. */
const SERVER_COMMANDS = new Set(["pair", "stop", "slim-transcripts"])

// The one entry for `kanna`: the supervisor, or the server child it spawns
// (restart.ts). bin/kanna loads this from source in a checkout and from the
// bundle (scripts/build-server.ts) in the published package.
if (process.argv[2] === "secret") {
  // Before the supervisor: an agent's shell runs this to use a secret, and it
  // must neither start a server nor take the instance lock (secret-cli.ts).
  const { runSecretCommand } = await import("./secret-cli")
  process.exit(await runSecretCommand(process.argv.slice(3)))
} else if (process.argv[2] && !process.argv[2].startsWith("-") && !SERVER_COMMANDS.has(process.argv[2])) {
  // `kanna tools list` and `kanna <tool>`, from an agent's shell, likewise
  // before the supervisor (kanna-tool-cli.ts). It names the unknown ones.
  const { runKannaToolCommand } = await import("./kanna-tool-cli")
  // exitCode, not exit(): a long result piped to another command must be written out first.
  process.exitCode = await runKannaToolCommand(process.argv.slice(2))
} else if (process.env[CLI_CHILD_MODE_ENV_VAR] === CLI_CHILD_MODE) {
  // Read once: the server's terminals and agents inherit its env, and a
  // `kanna` run in one of them must start its own supervisor.
  delete process.env[CLI_CHILD_MODE_ENV_VAR]
  await import("./cli")
} else {
  await import("./cli-supervisor")
}
