import type {
  ChatPermissionPolicy,
  PolicyVerdict,
} from "../shared/permission-policy"
import { parse as shellParse } from "shell-quote"
import path from "node:path"
import { homedir } from "node:os"
import { minimatch } from "minimatch"

export interface EvaluateArgs {
  toolName: string
  args: Record<string, unknown>
  chatPolicy: ChatPermissionPolicy
  cwd: string
}

export interface EvaluateResult {
  verdict: PolicyVerdict
  reason?: string
}

function argsToText(args: Record<string, unknown>): string {
  return typeof args.command === "string" ? args.command : JSON.stringify(args)
}

interface ShellOp { op: string }
function isShellOp(token: unknown): token is ShellOp {
  return typeof token === "object" && token !== null && "op" in (token as object)
}

interface ParsedSimpleCommand {
  verb: string
  paths: string[]
  hadEnvPrefix: boolean
}

function parseSimpleBash(
  command: string,
  cwd: string,
  autoAllowVerbs: string[],
): ParsedSimpleCommand | null {
  const tokens = shellParse(command)
  for (const t of tokens) {
    if (isShellOp(t)) return null  // pipe/redirect/subshell/glob/etc.
  }
  const stringTokens = tokens.filter((t): t is string => typeof t === "string")
  if (stringTokens.length === 0) return null

  let hadEnvPrefix = false
  let i = 0
  while (i < stringTokens.length && /^[A-Z_][A-Z0-9_]*=/.test(stringTokens[i])) {
    hadEnvPrefix = true
    i++
  }
  const rest = stringTokens.slice(i)
  if (rest.length === 0) return null

  let verb: string | null = null
  let argsStart = 1
  const sorted = [...autoAllowVerbs].sort((a, b) => b.length - a.length)
  for (const candidate of sorted) {
    const parts = candidate.split(/\s+/)
    if (rest.length >= parts.length && parts.every((p, idx) => rest[idx] === p)) {
      verb = candidate
      argsStart = parts.length
      break
    }
  }
  if (!verb) {
    verb = rest[0]
    argsStart = 1
  }

  const paths: string[] = []
  for (const arg of rest.slice(argsStart)) {
    const isPathLike = arg.startsWith("~") || arg.includes("/") || arg.startsWith(".")
    if (!isPathLike) continue
    const expanded = arg.startsWith("~")
      ? path.join(homedir(), arg.slice(1).replace(/^\//, ""))
      : arg
    const resolved = path.resolve(cwd, expanded)
    paths.push(resolved)
  }
  return { verb, paths, hadEnvPrefix }
}

const READ_PATH_TOOLS = new Set([
  "mcp__kanna__read",
  "mcp__kanna__glob",
  "mcp__kanna__grep",
])
const WRITE_PATH_TOOLS = new Set([
  "mcp__kanna__write",
  "mcp__kanna__edit",
])

function getPathArg(args: Record<string, unknown>): string | null {
  if (typeof args.path === "string") return args.path
  return null
}

function pathMatchesDeny(absPath: string, deny: string[]): string | null {
  for (const pattern of deny) {
    let expanded = pattern.startsWith("~")
      ? path.join(homedir(), pattern.slice(1).replace(/^\//, ""))
      : pattern
    // Normalize trailing slash so "/some/dir/" matches the same as "/some/dir"
    if (expanded.endsWith("/") && expanded !== "/") expanded = expanded.slice(0, -1)
    const matchPattern = expanded.endsWith("/**") || expanded.includes("*")
      ? expanded
      : `${expanded}/**`
    if (minimatch(absPath, matchPattern, { dot: true }) || absPath === expanded) {
      return pattern
    }
  }
  return null
}

/**
 * Tools whose entire purpose is to surface a question / plan to the user
 * and wait for an answer. They MUST always go through the "ask" path so
 * the durable approval protocol renders UI and the model receives the
 * user's actual response. Auto-allow/auto-deny would resolve the request
 * with no payload, leaving the shim's `formatAnswer` with an undefined
 * payload — producing an empty `text` field and an MCP -32602
 * "Invalid tools/call result" validation error (issue #215 follow-up).
 * No `chatPolicy.defaultAction` value can override this.
 */
const INTERACTIVE_TOOLS = new Set([
  "mcp__kanna__ask_user_question",
  "mcp__kanna__exit_plan_mode",
])

export const policy = {
  evaluate(args: EvaluateArgs): EvaluateResult {
    if (INTERACTIVE_TOOLS.has(args.toolName)) {
      return { verdict: "ask", reason: "interactive tool: always asks the user" }
    }
    if (READ_PATH_TOOLS.has(args.toolName)) {
      const p = getPathArg(args.args)
      if (p !== null) {
        const expanded = p.startsWith("~")
          ? path.join(homedir(), p.slice(1).replace(/^\//, ""))
          : p
        const resolved = path.resolve(args.cwd, expanded)
        const denied = pathMatchesDeny(resolved, args.chatPolicy.readPathDeny)
        if (denied) {
          return { verdict: "auto-deny", reason: `readPathDeny: ${denied}` }
        }
      }
    }
    if (WRITE_PATH_TOOLS.has(args.toolName)) {
      const p = getPathArg(args.args)
      if (p !== null) {
        const expanded = p.startsWith("~")
          ? path.join(homedir(), p.slice(1).replace(/^\//, ""))
          : p
        const resolved = path.resolve(args.cwd, expanded)
        const deniedW = pathMatchesDeny(resolved, args.chatPolicy.writePathDeny)
        const deniedR = pathMatchesDeny(resolved, args.chatPolicy.readPathDeny)
        if (deniedW) return { verdict: "auto-deny", reason: `writePathDeny: ${deniedW}` }
        if (deniedR) return { verdict: "auto-deny", reason: `readPathDeny: ${deniedR}` }
      }
    }

    // Bash path: single block handles all bash decisions.
    // Path-deny + tool-deny always run; the only thing chatPolicy.defaultAction
    // changes is the fallback for "didn't hit a deny rule and didn't hit the
    // verb allowlist". For personal-use (defaultAction: auto-allow) that's
    // auto-allow; for shared sessions (defaultAction: ask) it's ask.
    if (args.toolName === "mcp__kanna__bash") {
      const command = typeof args.args.command === "string" ? args.args.command : ""
      const parsed = parseSimpleBash(command, args.cwd, args.chatPolicy.bash.autoAllowVerbs)
      const fallback: PolicyVerdict = args.chatPolicy.defaultAction === "ask"
        ? "ask"
        : args.chatPolicy.defaultAction
      // Deny-list applies regardless of shell-feature parsing.
      for (const rule of args.chatPolicy.toolDenyList) {
        if (rule.tool !== args.toolName) continue
        let re: RegExp
        try {
          re = new RegExp(rule.pattern)
        } catch {
          console.warn(`[permission-gate] invalid regex pattern: ${rule.pattern}`)
          continue
        }
        if (re.test(argsToText(args.args))) {
          return { verdict: "auto-deny", reason: `matched denylist: ${rule.pattern}` }
        }
      }
      if (!parsed) {
        return { verdict: fallback, reason: "bash command uses shell features" }
      }
      if (parsed.hadEnvPrefix) {
        return { verdict: fallback, reason: "bash command has env prefix" }
      }
      for (const p of parsed.paths) {
        const denied = pathMatchesDeny(p, args.chatPolicy.readPathDeny)
        if (denied) {
          return { verdict: "auto-deny", reason: `readPathDeny: ${denied}` }
        }
      }
      if (args.chatPolicy.bash.autoAllowVerbs.includes(parsed.verb)) {
        return { verdict: "auto-allow", reason: `verb in autoAllowVerbs: ${parsed.verb}` }
      }
      return { verdict: fallback, reason: "bash verb not on autoAllowVerbs" }
    }

    // Non-bash path: deny-list, allow-list, default.
    // 1. Deny list wins over everything.
    for (const rule of args.chatPolicy.toolDenyList) {
      if (rule.tool !== args.toolName) continue
      let re: RegExp
      try {
        re = new RegExp(rule.pattern)
      } catch {
        console.warn(`[permission-gate] invalid regex pattern: ${rule.pattern}`)
        continue
      }
      if (re.test(argsToText(args.args))) {
        return { verdict: "auto-deny", reason: `matched denylist: ${rule.pattern}` }
      }
    }

    // 2. Allow list
    for (const rule of args.chatPolicy.toolAllowList) {
      if (rule.tool !== args.toolName) continue
      let re: RegExp
      try {
        re = new RegExp(rule.pattern)
      } catch {
        console.warn(`[permission-gate] invalid regex pattern: ${rule.pattern}`)
        continue
      }
      if (re.test(argsToText(args.args))) {
        return { verdict: "auto-allow", reason: `matched allowlist: ${rule.pattern}` }
      }
    }

    // 4. Default action.
    return { verdict: args.chatPolicy.defaultAction === "ask" ? "ask" : args.chatPolicy.defaultAction }
  },
}
