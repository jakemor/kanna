import process from "node:process"
import path from "node:path"
import {
  CLI_CHILD_ARGS_ENV_VAR,
  CLI_CHILD_COMMAND_ENV_VAR,
} from "../src/server/restart"

// Run the checked-out RC entrypoint through the normal supervisor so restart
// behavior works without requiring a globally installed `kanna-rc` binary.
process.env.KANNA_RUNTIME_PROFILE = "rc"
process.env.KANNA_DISABLE_SELF_UPDATE = "1"
process.env[CLI_CHILD_COMMAND_ENV_VAR] = process.execPath
process.env[CLI_CHILD_ARGS_ENV_VAR] = JSON.stringify([
  path.resolve(import.meta.dir, "../bin/kanna-rc"),
])

await import("../src/server/cli-supervisor")
