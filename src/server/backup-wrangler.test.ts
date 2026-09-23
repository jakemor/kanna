import { expect, test } from "bun:test"
import { WranglerBackupAuth } from "./backup-wrangler"

test("Wrangler only returns safe account fields and coalesces token reads", async () => {
  const commands: string[][] = []
  const auth = new WranglerBackupAuth("/tmp", async (args) => {
    commands.push(args)
    if (args[0] === "whoami") return JSON.stringify({ loggedIn: true, email: "private@example.com", accounts: [{ id: "a".repeat(32), name: "Personal", settings: { private: true } }] })
    return JSON.stringify({ type: "oauth", token: "secret-cli-token" })
  })
  expect(await auth.accounts()).toEqual([{ id: "a".repeat(32), name: "Personal" }])
  expect(await Promise.all([auth.token(), auth.token()])).toEqual(["secret-cli-token", "secret-cli-token"])
  expect(commands.filter((args) => args[0] === "auth")).toHaveLength(1)
  auth.invalidate()
  await auth.token()
  expect(commands.filter((args) => args[0] === "auth")).toHaveLength(2)
})

test("CLI errors and unexpected credential formats never leak subprocess output", async () => {
  const auth = new WranglerBackupAuth("/tmp", async () => { throw new Error("stderr: secret-cli-token") })
  await expect(auth.token()).rejects.toThrow("Sign in with Wrangler")
  await expect(auth.accounts()).rejects.toThrow("Run wrangler login")
  const invalid = new WranglerBackupAuth("/tmp", async () => JSON.stringify({ type: "global_api_key", key: "secret-cli-token" }))
  await expect(invalid.token()).rejects.toThrow("Sign in with Wrangler")
})
