import { describe, expect, test } from "bun:test"
import { policy } from "./permission-gate"
import { POLICY_DEFAULT } from "../shared/permission-policy"

describe("policy.evaluate basics", () => {
  test("defaultAction 'ask' → ask verdict", () => {
    const verdict = policy.evaluate({
      toolName: "mcp__kanna__webfetch",
      args: { url: "https://example.com" },
      chatPolicy: POLICY_DEFAULT,
      cwd: "/tmp",
    })
    expect(verdict.verdict).toBe("ask")
  })

  test("defaultAction 'auto-allow' → auto-allow verdict", () => {
    const verdict = policy.evaluate({
      toolName: "mcp__kanna__webfetch",
      args: { url: "https://example.com" },
      chatPolicy: { ...POLICY_DEFAULT, defaultAction: "auto-allow" },
      cwd: "/tmp",
    })
    expect(verdict.verdict).toBe("auto-allow")
  })

  test("toolDenyList regex match → auto-deny with reason", () => {
    const verdict = policy.evaluate({
      toolName: "mcp__kanna__bash",
      args: { command: "rm -rf /" },
      chatPolicy: POLICY_DEFAULT,
      cwd: "/tmp",
    })
    expect(verdict.verdict).toBe("auto-deny")
    expect(verdict.reason).toContain("denylist")
  })

  test("deny-list overrides defaultAction auto-allow", () => {
    const verdict = policy.evaluate({
      toolName: "mcp__kanna__bash",
      args: { command: "rm -rf /" },
      chatPolicy: { ...POLICY_DEFAULT, defaultAction: "auto-allow" },
      cwd: "/tmp",
    })
    expect(verdict.verdict).toBe("auto-deny")
  })

  // Issue #215 follow-up: interactive tools must always ask, regardless
  // of chatPolicy.defaultAction. Auto-allow would resolve with no payload
  // and crash the MCP shim formatter (-32602).
  test("mcp__kanna__ask_user_question always asks even under auto-allow policy", () => {
    const verdict = policy.evaluate({
      toolName: "mcp__kanna__ask_user_question",
      args: { questions: [{ text: "x", header: "h", multiSelect: false, options: [{ label: "a", description: "" }, { label: "b", description: "" }] }] },
      chatPolicy: { ...POLICY_DEFAULT, defaultAction: "auto-allow" },
      cwd: "/tmp",
    })
    expect(verdict.verdict).toBe("ask")
  })

  test("mcp__kanna__exit_plan_mode always asks even under auto-allow policy", () => {
    const verdict = policy.evaluate({
      toolName: "mcp__kanna__exit_plan_mode",
      args: { plan: "do stuff" },
      chatPolicy: { ...POLICY_DEFAULT, defaultAction: "auto-allow" },
      cwd: "/tmp",
    })
    expect(verdict.verdict).toBe("ask")
  })

  test("interactive tools also ask under auto-deny policy (UI is the only outcome)", () => {
    const verdict = policy.evaluate({
      toolName: "mcp__kanna__ask_user_question",
      args: { questions: [] },
      chatPolicy: { ...POLICY_DEFAULT, defaultAction: "auto-deny" },
      cwd: "/tmp",
    })
    expect(verdict.verdict).toBe("ask")
  })
})

describe("bash arg parsing", () => {
  const policyWithDefaults = POLICY_DEFAULT

  test("plain `ls` → auto-allow", () => {
    const v = policy.evaluate({
      toolName: "mcp__kanna__bash",
      args: { command: "ls" },
      chatPolicy: policyWithDefaults,
      cwd: "/tmp/project",
    })
    expect(v.verdict).toBe("auto-allow")
  })

  test("`cat ~/.ssh/id_rsa` → auto-deny (readPathDeny)", () => {
    const v = policy.evaluate({
      toolName: "mcp__kanna__bash",
      args: { command: "cat ~/.ssh/id_rsa" },
      chatPolicy: policyWithDefaults,
      cwd: "/tmp/project",
    })
    expect(v.verdict).toBe("auto-deny")
    expect(v.reason).toContain("readPathDeny")
  })

  test("`cat ~/.claude/.credentials.json` → auto-deny", () => {
    const v = policy.evaluate({
      toolName: "mcp__kanna__bash",
      args: { command: "cat ~/.claude/.credentials.json" },
      chatPolicy: policyWithDefaults,
      cwd: "/tmp/project",
    })
    expect(v.verdict).toBe("auto-deny")
  })

  test("pipe `ls | grep foo` → ask (downgrades)", () => {
    const v = policy.evaluate({
      toolName: "mcp__kanna__bash",
      args: { command: "ls | grep foo" },
      chatPolicy: policyWithDefaults,
      cwd: "/tmp/project",
    })
    expect(v.verdict).toBe("ask")
  })

  test("subshell `cat $(echo ~/.ssh/id_rsa)` → ask", () => {
    const v = policy.evaluate({
      toolName: "mcp__kanna__bash",
      args: { command: "cat $(echo ~/.ssh/id_rsa)" },
      chatPolicy: policyWithDefaults,
      cwd: "/tmp/project",
    })
    expect(v.verdict).toBe("ask")
  })

  test("env-prefix `FOO=bar ls` → ask", () => {
    const v = policy.evaluate({
      toolName: "mcp__kanna__bash",
      args: { command: "FOO=bar ls" },
      chatPolicy: policyWithDefaults,
      cwd: "/tmp/project",
    })
    expect(v.verdict).toBe("ask")
  })

  test("chain `ls && rm file` → ask", () => {
    const v = policy.evaluate({
      toolName: "mcp__kanna__bash",
      args: { command: "ls && rm file" },
      chatPolicy: policyWithDefaults,
      cwd: "/tmp/project",
    })
    expect(v.verdict).toBe("ask")
  })

  test("`git status` (multi-word verb in autoAllowVerbs) → auto-allow", () => {
    const v = policy.evaluate({
      toolName: "mcp__kanna__bash",
      args: { command: "git status" },
      chatPolicy: policyWithDefaults,
      cwd: "/tmp/project",
    })
    expect(v.verdict).toBe("auto-allow")
  })

  test("unrecognized verb → ask", () => {
    const v = policy.evaluate({
      toolName: "mcp__kanna__bash",
      args: { command: "curl https://example.com" },
      chatPolicy: policyWithDefaults,
      cwd: "/tmp/project",
    })
    expect(v.verdict).toBe("ask")
  })
})

describe("path-deny for read/edit/write tools", () => {
  test("mcp__kanna__read path in readPathDeny → auto-deny", () => {
    const v = policy.evaluate({
      toolName: "mcp__kanna__read",
      args: { path: "~/.ssh/id_rsa" },
      chatPolicy: POLICY_DEFAULT,
      cwd: "/tmp/project",
    })
    expect(v.verdict).toBe("auto-deny")
    expect(v.reason).toContain("readPathDeny")
  })

  test("mcp__kanna__read non-sensitive path → falls through to default", () => {
    const v = policy.evaluate({
      toolName: "mcp__kanna__read",
      args: { path: "/tmp/project/src/foo.ts" },
      chatPolicy: POLICY_DEFAULT,
      cwd: "/tmp/project",
    })
    expect(v.verdict).toBe("ask")
  })

  test("mcp__kanna__write path in writePathDeny → auto-deny", () => {
    const v = policy.evaluate({
      toolName: "mcp__kanna__write",
      args: { path: "/etc/passwd", content: "x" },
      chatPolicy: POLICY_DEFAULT,
      cwd: "/tmp/project",
    })
    expect(v.verdict).toBe("auto-deny")
    expect(v.reason).toContain("writePathDeny")
  })

  test("mcp__kanna__edit path in writePathDeny → auto-deny", () => {
    const v = policy.evaluate({
      toolName: "mcp__kanna__edit",
      args: { path: "~/.aws/credentials", oldString: "a", newString: "b" },
      chatPolicy: POLICY_DEFAULT,
      cwd: "/tmp/project",
    })
    expect(v.verdict).toBe("auto-deny")
    expect(v.reason).toContain("writePathDeny")
  })

  test("mcp__kanna__glob with deny-matching path → auto-deny", () => {
    const v = policy.evaluate({
      toolName: "mcp__kanna__glob",
      args: { path: "~/.ssh/" },
      chatPolicy: POLICY_DEFAULT,
      cwd: "/tmp/project",
    })
    expect(v.verdict).toBe("auto-deny")
  })
})

describe("regex try/catch guard", () => {
  test("malformed pattern in bash denyList → skipped, returns default verdict instead of throwing", () => {
    const result = policy.evaluate({
      toolName: "mcp__kanna__bash",
      args: { command: "ls" },
      chatPolicy: {
        ...POLICY_DEFAULT,
        toolDenyList: [
          { tool: "mcp__kanna__bash", pattern: "[" }, // invalid regex
        ],
      },
      cwd: "/tmp/project",
    })
    // Should not throw — malformed pattern skipped, falls through to auto-allow for "ls".
    expect(result.verdict).toBe("auto-allow")
  })

  test("malformed pattern in non-bash denyList → skipped, returns default verdict instead of throwing", () => {
    const result = policy.evaluate({
      toolName: "mcp__kanna__webfetch",
      args: { url: "https://example.com" },
      chatPolicy: {
        ...POLICY_DEFAULT,
        toolDenyList: [
          { tool: "mcp__kanna__webfetch", pattern: "[" }, // invalid regex
        ],
        defaultAction: "auto-allow",
      },
      cwd: "/tmp/project",
    })
    expect(result.verdict).toBe("auto-allow")
  })

  test("malformed pattern in non-bash allowList → skipped, falls to default action", () => {
    const result = policy.evaluate({
      toolName: "mcp__kanna__webfetch",
      args: { url: "https://example.com" },
      chatPolicy: {
        ...POLICY_DEFAULT,
        toolAllowList: [
          { tool: "mcp__kanna__webfetch", pattern: "[" }, // invalid regex
        ],
        defaultAction: "ask",
      },
      cwd: "/tmp/project",
    })
    expect(result.verdict).toBe("ask")
  })
})
