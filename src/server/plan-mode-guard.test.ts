import { describe, expect, test } from "bun:test"
import { parseShellLine, planModeRefusal, shellLineWrites } from "./plan-mode-guard"

describe("shellLineWrites", () => {
  test("what a plan needs to look around is run", () => {
    for (const line of [
      "git log --oneline -1",
      "git status --short",
      "git diff HEAD~1 -- src/server/agent.ts",
      "git -C packages/app log -p -3",
      "git --no-pager show HEAD:README.md",
      "git branch -a",
      "git branch -vv",
      "git branch --show-current",
      "git branch --contains abc123",
      "git tag -l 'v1.*'",
      "git remote -v",
      "git stash list",
      "git config --get remote.origin.url",
      "cat README.md",
      "ls -la src | head -20",
      "cd packages/app && ls",
      "grep -rn \"TODO\" src | wc -l",
      "rg --files -g '*.ts' | sort | uniq -c",
      "find . -name '*.test.ts' -newer package.json",
      "cat package.json | jq '.scripts'",
      "ls nope 2>/dev/null || echo missing",
      "git log 2>&1 | tail -5",
      "wc -l < README.md",
      "echo \"$HOME\"",
      "gh pr view 42 --json title",
      "gh api repos/acme/app/pulls",
      "",
    ]) {
      expect([line, shellLineWrites(line)]).toEqual([line, null])
    }
  })

  test("what changes something, or could, is not", () => {
    for (const line of [
      // Plainly writes.
      "touch notes.txt",
      "rm -rf build",
      "mkdir out",
      "git commit -am wip",
      "git checkout main",
      "git push",
      "git branch feature",
      "git branch -D old",
      "git tag v2",
      "git tag -a v2 -m release",
      "git stash",
      "git config user.name me",
      "git remote add evil https://example.com/x.git",
      "npm install",
      // Runs a program the list cannot see into.
      "node -e \"require('fs').writeFileSync('x','')\"",
      "python3 -c 'open(\"x\",\"w\")'",
      "bash -c 'rm x'",
      "sh script.sh",
      "xargs rm",
      "env rm x",
      "awk 'BEGIN { system(\"rm x\") }'",
      "sed -i s/a/b/ file",
      "find . -name '*.log' -delete",
      "find . -exec rm {} +",
      "rg --pre ./evil pattern",
      "fd -x rm",
      "git -c core.pager=./evil log",
      "git -c core.fsmonitor=./evil status",
      "git log --output=stolen.txt",
      "git diff --ext-diff",
      // Reads, but sends what it read to a file.
      "cat secret > copy.txt",
      "echo hi >> notes.txt",
      "git log 2> errors.txt",
      "sort -o sorted.txt names.txt",
      "uniq names.txt deduped.txt",
      "tree -o listing.txt",
      // Hides a command inside one that reads.
      "echo $(rm x)",
      "echo `rm x`",
      "cat \"$(touch x)\"",
      "diff <(rm x) y",
      "(rm x)",
      "ls; rm x",
      "ls && rm x",
      "ls || rm x",
      "ls | tee copy.txt",
      "ls\nrm x",
      "ls & rm x",
      "FOO=1 rm x",
      "/bin/rm x",
      "gh pr merge 42",
      "gh api repos/acme/app/issues -f title=x",
      "gh api -X DELETE repos/acme/app",
    ]) {
      expect([line, typeof shellLineWrites(line)]).toEqual([line, "string"])
    }
  })

  test("quotes are read the way a shell reads them", () => {
    expect(parseShellLine("grep 'a; rm x' file")).toEqual({ ok: true, commands: [["grep", "a; rm x", "file"]] })
    expect(parseShellLine('grep "a | b > c" file')).toEqual({ ok: true, commands: [["grep", "a | b > c", "file"]] })
    expect(parseShellLine("ls -la | head -3 && git status")).toEqual({ ok: true, commands: [["ls", "-la"], ["head", "-3"], ["git", "status"]] })
    expect(parseShellLine("echo 'unclosed")).toEqual({ ok: false, reason: "it has an unclosed quote" })
    // A quoted name is still the name.
    expect(shellLineWrites("'rm' x")).toContain("rm")
    expect(shellLineWrites("\\rm x")).toContain("rm")
  })
})

describe("planModeRefusal", () => {
  const env = { CLAUDE_CONFIG_DIR: "/home/me/.claude" }

  test("a shell command that changes something is refused, and one that reads is not", () => {
    expect(planModeRefusal("Bash", { command: "rm -rf build" }, env)).toContain("plan mode")
    expect(planModeRefusal("Bash", { command: "touch notes.txt" }, env)).toContain("not on the list")
    expect(planModeRefusal("Monitor", { command: "npm run dev" }, env)).toContain("plan mode")
    expect(planModeRefusal("Bash", { command: "git log --oneline -1" }, env)).toBeNull()
    expect(planModeRefusal("Bash", { command: "cat README.md | head -5" }, env)).toBeNull()
  })

  test("a file is not written, except the plan itself", () => {
    expect(planModeRefusal("Write", { file_path: "/repo/src/index.ts", content: "x" }, env)).toContain("plan mode")
    expect(planModeRefusal("Edit", { file_path: "/repo/src/index.ts" }, env)).toContain("plan mode")
    expect(planModeRefusal("NotebookEdit", { notebook_path: "/repo/analysis.ipynb" }, env)).toContain("plan mode")
    expect(planModeRefusal("Write", { file_path: "/home/me/.claude/plans/tidy-otter.md" }, env)).toBeNull()
    expect(planModeRefusal("Write", { file_path: "/home/me/.claude/plans/../settings.json" }, env)).toContain("plan mode")
  })

  test("reading, searching, the web and Kanna's own tools are not this function's to stop", () => {
    expect(planModeRefusal("Read", { file_path: "/etc/hostname" }, env)).toBeNull()
    expect(planModeRefusal("WebFetch", { url: "https://example.com" }, env)).toBeNull()
    expect(planModeRefusal("mcp__kanna__read_chat", {}, env)).toBeNull()
    expect(planModeRefusal("ExitPlanMode", {}, env)).toBeNull()
  })
})
