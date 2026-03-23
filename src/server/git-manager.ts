import type { GitBranchesResult, GitCreateBranchResult, GitSwitchBranchResult } from "../shared/protocol"

export class GitManager {
  private async runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
  }

  async getBranches(localPath: string): Promise<GitBranchesResult> {
    const [branchResult, headResult] = await Promise.all([
      this.runGit(localPath, ["branch"]),
      this.runGit(localPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ])

    if (branchResult.exitCode !== 0 || headResult.exitCode !== 0) {
      return { isRepo: false, currentBranch: null, branches: [] }
    }

    const branches = branchResult.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.slice(2)) // strip "* " or "  " prefix
      .sort((a, b) => a.localeCompare(b))

    const currentBranch = headResult.stdout === "HEAD" ? null : headResult.stdout

    return { isRepo: true, currentBranch, branches }
  }

  async switchBranch(localPath: string, branchName: string): Promise<GitSwitchBranchResult> {
    const result = await this.runGit(localPath, ["switch", branchName])
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to switch to branch "${branchName}"`)
    }
    const head = await this.runGit(localPath, ["rev-parse", "--abbrev-ref", "HEAD"])
    return { currentBranch: head.stdout }
  }

  async createBranch(localPath: string, branchName: string, checkout: boolean): Promise<GitCreateBranchResult> {
    const args = checkout ? ["switch", "-c", branchName] : ["branch", branchName]
    const result = await this.runGit(localPath, args)
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to create branch "${branchName}"`)
    }
    const head = await this.runGit(localPath, ["rev-parse", "--abbrev-ref", "HEAD"])
    return { currentBranch: head.stdout }
  }
}
