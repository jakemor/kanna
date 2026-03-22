import process from "node:process"

process.env.KANNA_RUNTIME_PROFILE = "dev"
process.env.KANNA_DISABLE_SELF_UPDATE = "1"

await import("../src/server/cli")
