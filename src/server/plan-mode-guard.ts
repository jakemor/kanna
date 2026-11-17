/**
 * What a Claude session may do while it is in plan mode.
 *
 * Plan mode is read-only, and elsewhere Kanna leans on that (a chat in plan
 * mode can only start chats in plan mode: `ChatOrchestrator.resolveRun`). The
 * CLI on its own does not hold a session to it:
 *
 *  - A file write it asks about, and Kanna's `canUseTool` said yes to every
 *    ask, so `Write` created the file.
 *  - A shell command it does not ask about at all. It hands the command to a
 *    safety classifier, which answers whether the command is dangerous, not
 *    whether it changes anything: `touch notes.txt` and a `node -e` that
 *    writes a file both ran, with no callback of ours consulted.
 *
 * So the decision is made here, and it is made from a `PreToolUse` hook
 * (`startClaudeSession`), which the CLI runs before every tool call whatever
 * the permission mode.
 *
 * A shell command is let through only when it can be seen to read: every
 * command in it is on a list of ones that do, with none of the flags that
 * make them write or run something else, and no redirection to a file. That
 * is deliberately narrow. What it turns away the agent can usually do with
 * `Read`, `Grep` and `Glob`, and the refusal says so.
 */

import { homedir } from "node:os"
import path from "node:path"

type Verdict = string | null

const READ_ONLY = "read-only"

/** Words of one command, and why the line could not be split into commands when it could not. */
type Parsed = { ok: true; commands: string[][] } | { ok: false; reason: string }

/**
 * Splits a shell line into its commands (at `|`, `&&`, `||`, `;` and line
 * breaks), honouring quotes. Anything that would run a command this cannot
 * see, or send output to a file, ends the parse with the reason.
 */
export function parseShellLine(line: string): Parsed {
  const commands: string[][] = []
  let words: string[] = []
  let word = ""
  let hasWord = false
  const endWord = () => {
    if (hasWord) words.push(word)
    word = ""
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  const fail = (reason: string): Parsed => ({ ok: false, reason })

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    const next = line[index + 1]

    if (char === "'") {
      const close = line.indexOf("'", index + 1)
      if (close === -1) return fail("it has an unclosed quote")
      word += line.slice(index + 1, close)
      hasWord = true
      index = close
      continue
    }
    if (char === '"') {
      let close = index + 1
      let text = ""
      for (; close < line.length && line[close] !== '"'; close += 1) {
        const inner = line[close]!
        if (inner === "`" || (inner === "$" && line[close + 1] === "(")) return fail("it runs another command inside it ($(...) or backticks)")
        if (inner === "\\" && close + 1 < line.length) {
          close += 1
          text += line[close]
          continue
        }
        text += inner
      }
      if (close >= line.length) return fail("it has an unclosed quote")
      word += text
      hasWord = true
      index = close
      continue
    }
    if (char === "\\") {
      if (next === undefined || next === "\n") return fail("it continues onto another line")
      word += next
      hasWord = true
      index += 1
      continue
    }
    if (char === "`" || (char === "$" && next === "(")) return fail("it runs another command inside it ($(...) or backticks)")
    if (char === "(" || char === ")") return fail("it uses a subshell")
    if (char === "\n" || char === ";") {
      endCommand()
      continue
    }
    if (char === "|") {
      endCommand()
      if (next === "|") index += 1
      continue
    }
    if (char === "&") {
      if (next === "&") {
        endCommand()
        index += 1
        continue
      }
      // `2>&1` is handled where the `>` is; a bare `&` runs in the background.
      return fail("it starts a background job (&)")
    }
    if (char === ">") {
      // The descriptor before it (`2>`) is part of the redirection, not an argument.
      if (hasWord && /^\d+$/.test(word)) {
        word = ""
        hasWord = false
      } else {
        endWord()
      }
      let cursor = index + 1
      if (line[cursor] === ">") cursor += 1
      while (line[cursor] === " " || line[cursor] === "\t") cursor += 1
      const target = /^(&\d|\/dev\/null(?![\w./-]))/.exec(line.slice(cursor))
      if (!target) return fail("it writes its output to a file")
      index = cursor + target[0].length - 1
      continue
    }
    if (char === "<") {
      if (next === "(") return fail("it runs another command inside it (<(...))")
      // Input redirection reads. The file name that follows is taken as a word.
      endWord()
      continue
    }
    if (char === " " || char === "\t" || char === "\r") {
      endWord()
      continue
    }
    word += char
    hasWord = true
  }
  endCommand()
  return { ok: true, commands }
}

/** A short option given alone or bundled with others: `-o`, `-no`. Not `--output`. */
function hasShortFlag(args: string[], letter: string) {
  return args.some((arg) => /^-[A-Za-z]+/.test(arg) && !arg.startsWith("--") && arg.slice(1).includes(letter))
}

function hasLongFlag(args: string[], ...names: string[]) {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)))
}

const anyArguments = (): Verdict => null

const GIT_READ_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "shortlog",
  "cat-file", "grep", "merge-base", "rev-list", "show-ref", "name-rev", "for-each-ref", "count-objects",
  "whatchanged", "diff-tree", "diff-index", "diff-files", "check-ignore", "check-attr", "var", "version", "help",
])

/**
 * `git branch` and `git tag` list unless they are given a name to make, or a
 * flag that changes one. `changingShortFlags` is per command: `-a` lists every
 * branch, and makes an annotated tag.
 */
function listingOnly(args: string[], changingShortFlags: string, what: string): Verdict {
  // The switches that put the command in list mode, where a bare word is a pattern or a commit.
  const listMode = ["--list", "-l", "--merged", "--no-merged", "--contains", "--no-contains", "--points-at"]
  const positional = args.filter((arg) => !arg.startsWith("-"))
  if (positional.length > 0 && !args.some((arg) => listMode.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) {
    return `git ${what} with a name creates or changes one`
  }
  if ([...changingShortFlags].some((letter) => hasShortFlag(args, letter))
    || args.some((arg) => /^--(delete|move|copy|force|set-upstream-to|set-upstream|unset-upstream|edit-description|annotate|sign|local-user|message|file|edit|track|no-track|create-reflog|cleanup)(=|$)/.test(arg))) {
    return `that git ${what} command changes a ${what}`
  }
  return null
}

function checkGit(args: string[]): Verdict {
  let index = 0
  for (; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
      index += 1
      continue
    }
    if (arg === "--no-pager" || arg === "-P" || arg === "--no-optional-locks" || arg === "--literal-pathspecs"
      || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) continue
    // `-c name=value` can name a program for git to run (a pager, a diff driver).
    if (arg === "-c" || arg.startsWith("--config-env") || arg.startsWith("--exec-path") || arg === "-p" || arg === "--paginate") {
      return "that git option can make git run another program"
    }
    break
  }
  const subcommand = args[index]
  const rest = args.slice(index + 1)
  if (!subcommand) return null
  if (rest.some((arg) => arg.startsWith("--output") || arg === "--ext-diff" || arg.startsWith("--open-files-in-pager") || /^-O/.test(arg))) {
    return "that git option writes a file or runs another program"
  }
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) return null
  switch (subcommand) {
    case "branch":
      return listingOnly(rest, "dDmMcCfut", "branch")
    case "tag":
      return listingOnly(rest, "asdfmFue", "tag")
    case "remote":
      return rest.length === 0 || rest[0] === "-v" || rest[0] === "--verbose" || rest[0] === "show" || rest[0] === "get-url"
        ? null
        : "that git remote command changes the remotes"
    case "stash":
      return rest[0] === "list" || rest[0] === "show" ? null : "git stash changes the working tree"
    case "config":
      return (hasLongFlag(rest, "--get", "--get-all", "--get-regexp", "--list") || rest.includes("-l"))
        && !hasLongFlag(rest, "--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section", "--edit")
        && !rest.includes("-e")
        ? null
        : "git config without --get or --list can change the configuration"
    case "worktree":
      return rest[0] === "list" ? null : "that git worktree command changes worktrees"
    case "reflog":
      return rest.length === 0 || rest[0] === "show" || rest[0]!.startsWith("-") ? null : "that git reflog command changes the reflog"
    default:
      return `git ${subcommand} is not a command that only reads`
  }
}

const GH_READ: Record<string, Set<string>> = {
  pr: new Set(["view", "list", "diff", "checks", "status"]),
  issue: new Set(["view", "list", "status"]),
  repo: new Set(["view", "list"]),
  run: new Set(["view", "list"]),
  release: new Set(["view", "list"]),
  workflow: new Set(["view", "list"]),
  auth: new Set(["status"]),
  label: new Set(["list"]),
}

function checkGh(args: string[]): Verdict {
  const [group, action] = args
  if (!group) return null
  if (group === "status" || group === "search" || group === "--version" || group === "help") return null
  if (group === "api") {
    return hasLongFlag(args, "--method", "--field", "--raw-field", "--input") || hasShortFlag(args, "X") || hasShortFlag(args, "f") || hasShortFlag(args, "F")
      ? "that gh api call sends data (it is not a plain GET)"
      : null
  }
  return GH_READ[group]?.has(action ?? "") ? null : `gh ${group}${action ? ` ${action}` : ""} is not a command that only reads`
}

/**
 * The commands a plan may run, each with the check that keeps it to reading.
 * Left out on purpose: anything that takes a program to run (`xargs`, `env`,
 * `awk`, `sed`, `sh`, an interpreter), and anything that fetches or builds.
 */
const READ_COMMANDS: Record<string, (args: string[]) => Verdict> = {
  ls: anyArguments, cat: anyArguments, head: anyArguments, tail: anyArguments, wc: anyArguments, pwd: anyArguments,
  echo: anyArguments, printf: anyArguments, grep: anyArguments, egrep: anyArguments, fgrep: anyArguments,
  stat: anyArguments, du: anyArguments, df: anyArguments, whoami: anyArguments, uname: anyArguments,
  which: anyArguments, type: anyArguments, basename: anyArguments, dirname: anyArguments, realpath: anyArguments,
  readlink: anyArguments, cut: anyArguments, tr: anyArguments, nl: anyArguments, column: anyArguments,
  diff: anyArguments, cmp: anyArguments, md5sum: anyArguments, sha1sum: anyArguments, sha256sum: anyArguments,
  shasum: anyArguments, jq: anyArguments, true: anyArguments, false: anyArguments, test: anyArguments,
  "[": anyArguments, id: anyArguments, ps: anyArguments, nproc: anyArguments, uptime: anyArguments, cd: anyArguments,
  hostname: (args) => args.every((arg) => arg.startsWith("-")) ? null : "hostname with a name sets the host name",
  date: (args) => hasShortFlag(args, "s") || hasLongFlag(args, "--set") ? "that date command sets the clock" : null,
  file: (args) => hasShortFlag(args, "C") || hasLongFlag(args, "--compile") ? "file -C writes a compiled magic file" : null,
  sort: (args) => hasShortFlag(args, "o") || hasLongFlag(args, "--output", "--compress-program") ? "that sort writes a file or runs another program" : null,
  uniq: (args) => args.filter((arg) => !arg.startsWith("-")).length > 1 ? "uniq with a second file name writes to it" : null,
  tree: (args) => hasShortFlag(args, "o") ? "tree -o writes a file" : null,
  find: (args) => args.some((arg) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg))
    ? "that find runs a command or deletes or writes files"
    : null,
  rg: (args) => hasLongFlag(args, "--pre", "--hostname-bin") ? "that rg option runs another program" : null,
  fd: (args) => hasShortFlag(args, "x") || hasShortFlag(args, "X") || hasLongFlag(args, "--exec", "--exec-batch") ? "that fd runs a command" : null,
  git: checkGit,
  gh: checkGh,
}

/**
 * Why a shell line cannot be run in plan mode, or null when everything in it
 * only reads.
 */
export function shellLineWrites(line: string): Verdict {
  const parsed = parseShellLine(line)
  if (!parsed.ok) return parsed.reason
  for (const words of parsed.commands) {
    const [name, ...args] = words
    if (!name) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return "it sets a variable for a command"
    const check = Object.hasOwn(READ_COMMANDS, name) ? READ_COMMANDS[name]! : null
    if (!check) return `\`${name.slice(0, 40)}\` is not on the list of commands that only read`
    const verdict = check(args)
    if (verdict) return verdict
  }
  return null
}

/** Tools that change files. */
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])
/** Tools that are given a shell line to run. */
const SHELL_TOOLS = new Set(["Bash", "Monitor"])

/**
 * Why a Claude tool call is refused in plan mode, or null when it may run.
 * The one file a plan writes is its own, which the CLI keeps under its
 * config directory.
 */
export function planModeRefusal(toolName: string, input: unknown, env: Record<string, string | undefined> = process.env): string | null {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {}
  if (SHELL_TOOLS.has(toolName)) {
    const reason = shellLineWrites(typeof record.command === "string" ? record.command : "")
    if (!reason) return null
    return `This chat is in plan mode, which is ${READ_ONLY}, and this command was not run: ${reason}. `
      + "Commands that only read are run (ls, cat, head, tail, grep, rg, find, wc, git status/log/diff/show/blame, gh pr view), one after another or piped, with no output sent to a file. "
      + "For anything else use Read, Grep and Glob, or finish the plan and call ExitPlanMode to have it approved."
  }
  if (!FILE_WRITE_TOOLS.has(toolName)) return null
  const target = typeof record.file_path === "string" ? record.file_path : typeof record.notebook_path === "string" ? record.notebook_path : ""
  const plansDir = path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude"), "plans")
  if (target && path.resolve(target).startsWith(`${plansDir}${path.sep}`)) return null
  return `This chat is in plan mode, which is ${READ_ONLY}: files are not written until the plan is approved. Call ExitPlanMode with the plan.`
}
