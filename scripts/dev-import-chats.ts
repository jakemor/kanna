import process from "node:process"

process.env.KANNA_RUNTIME_PROFILE = "dev"
process.env.KANNA_DISABLE_SELF_UPDATE = "1"
process.argv.splice(2, 0, "import-chats")

await import("../src/server/cli")
