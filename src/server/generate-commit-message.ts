import path from "node:path"
import { QuickResponseAdapter } from "./quick-response"

interface CommitMessageFile {
  path: string
  changeType: "added" | "deleted" | "modified" | "renamed"
  patch: string
}

const COMMIT_MESSAGE_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["subject", "body"],
  additionalProperties: false,
} as const

export interface GenerateCommitMessageResult {
  subject: string
  body: string
  usedFallback: boolean
  failureMessage: string | null
}

function summarizeFailures(failures: Array<{ provider: "openai" | "claude" | "codex"; reason: string }>) {
  if (failures.length === 0) return null
  return failures.map((failure) => failure.reason).join("; ")
}

function limitText(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength).trimEnd()}\n...[truncated]`
}

function sanitizeSubject(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = (value.split(/\r?\n/u)[0] ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.]+$/u, "")
    .slice(0, 72)
    .trim()
  return normalized.length > 0 ? normalized : null
}

function sanitizeBody(value: unknown): string {
  if (typeof value !== "string") return ""
  return value.trim()
}

function fallbackSubject(files: CommitMessageFile[]) {
  if (files.length === 1) {
    const fileName = path.posix.basename(files[0]?.path ?? "file")
    const normalized = `Update ${fileName}`.replace(/\s+/g, " ").trim()
    return normalized.slice(0, 72).trim()
  }

  return `Update ${files.length} files`
}

function buildCommitMessagePrompt(args: {
  branchName?: string
  files: CommitMessageFile[]
}) {
  const fileList = args.files.map((file) => `${file.changeType}: ${file.path}`).join("\n")
  const combinedPatch = args.files.map((file) => file.patch).join("\n\n")

  return [
    "Generate a git commit message for the selected changes.",
    "Return JSON with keys: subject, body.",
    "Rules:",
    "- subject must be imperative, under 72 chars, and have no trailing period",
    "- body may be an empty string or 3-5 bullet points",
    "- capture the primary user-visible or developer-visible change",
    "",
    `Branch: ${args.branchName ?? "current branch"}`,
    "",
    "Selected files:",
    limitText(fileList, 6_000),
    "",
    "Selected patch:",
    limitText(combinedPatch, 40_000),
  ].join("\n")
}

export async function generateCommitMessageDetailed(
  args: {
    cwd: string
    branchName?: string
    files: CommitMessageFile[]
  },
  adapter = new QuickResponseAdapter()
): Promise<GenerateCommitMessageResult> {
  const result = await adapter.generateStructuredWithDiagnostics<{ subject: string; body: string }>({
    cwd: args.cwd,
    task: "commit message generation",
    prompt: buildCommitMessagePrompt(args),
    schema: COMMIT_MESSAGE_SCHEMA,
    parse: (value) => {
      const output = value && typeof value === "object" ? value as { subject?: unknown; body?: unknown } : {}
      const subject = sanitizeSubject(output.subject)
      if (!subject) return null
      return {
        subject,
        body: sanitizeBody(output.body),
      }
    },
  })

  if (result.value) {
    return {
      subject: result.value.subject,
      body: result.value.body,
      usedFallback: false,
      failureMessage: null,
    }
  }

  return {
    subject: fallbackSubject(args.files),
    body: "",
    usedFallback: true,
    failureMessage: summarizeFailures(result.failures),
  }
}
