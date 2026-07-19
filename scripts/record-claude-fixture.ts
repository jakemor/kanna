/**
 * Records one real Claude Agent SDK turn as a raw-message fixture for
 * src/server/claude-turn-replay.test.ts.
 *
 * Usage: bun run ./scripts/record-claude-fixture.ts
 *
 * Runs a small multi-tool prompt (TodoWrite + Bash + Read + text) in a
 * throwaway directory and writes every raw SDK message, one JSON per line, to
 * src/server/__fixtures__/claude-turn.jsonl. Requires working Claude Code
 * credentials, so it's a manual tool — the replay test consumes the committed
 * fixture and never needs credentials.
 *
 * The system/init message is sanitized before writing: the recording machine's
 * slash command, skill, and agent lists plus memory paths would otherwise be
 * committed with the fixture. The rest of the stream is written verbatim.
 */
import { query } from "@anthropic-ai/claude-agent-sdk"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import path from "node:path"

const FIXTURE_PATH = path.join(import.meta.dir, "../src/server/__fixtures__/claude-turn.jsonl")

const PROMPT = [
  "Do exactly the following, in order, without asking questions:",
  "1. Use Read to read the file ./hello.txt (relative to the current working directory).",
  "2. Use Bash to run `pwd`.",
  "3. Reply with a single short sentence summarizing what hello.txt says.",
].join("\n")

function sanitizeMessage(message: unknown): string {
  const record = message as { type?: string; subtype?: string } & Record<string, unknown>
  const sanitized = record.type === "system" && record.subtype === "init"
    ? {
        ...record,
        slash_commands: ["compact", "context", "init"],
        skills: [],
        agents: ["general-purpose"],
        memory_paths: {},
      }
    : message
  // Compact summaries and error strings can embed the recorder's home dir.
  return JSON.stringify(sanitized).replaceAll(homedir(), "/Users/recorder")
}

async function main() {
  const workDir = await mkdtemp(path.join(tmpdir(), "kanna-claude-fixture-"))
  await writeFile(path.join(workDir, "hello.txt"), "Kanna replay fixture: the quick brown fox.\n", "utf8")

  const lines: string[] = []
  try {
    const q = query({
      prompt: PROMPT,
      options: {
        cwd: workDir,
        permissionMode: "acceptEdits",
        // Mirrors the production session setup in agent.ts startClaudeSession:
        // TodoWrite (and friends) are only served when workflows are enabled.
        tools: ["Bash", "Read", "TodoWrite"],
        settings: { enableWorkflows: true },
        settingSources: [],
        pathToClaudeCodeExecutable: process.env.CLAUDE_EXECUTABLE?.replace(/^~(?=\/|$)/, homedir()) || undefined,
        env: (() => {
          const { CLAUDECODE: _, ...env } = process.env
          return env
        })(),
      },
    })

    for await (const message of q) {
      lines.push(sanitizeMessage(message))
      const summary = (message as { type?: string; subtype?: string })
      console.log(`recorded: ${summary.type}${summary.subtype ? `/${summary.subtype}` : ""}`)
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }

  if (lines.length === 0) {
    throw new Error("No SDK messages were recorded")
  }
  await mkdir(path.dirname(FIXTURE_PATH), { recursive: true })
  await writeFile(FIXTURE_PATH, `${lines.join("\n")}\n`, "utf8")
  console.log(`\nWrote ${lines.length} raw SDK messages to ${path.relative(process.cwd(), FIXTURE_PATH)}`)
}

await main()
