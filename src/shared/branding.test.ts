import { describe, expect, test } from "bun:test"
import {
  getDataDir,
  getDataDirDisplay,
  getDataRootName,
  getKeybindingsFilePath,
  getKeybindingsFilePathDisplay,
  getRuntimeProfile,
} from "./branding"

describe("runtime profile helpers", () => {
  test("defaults to the prod profile when unset", () => {
    expect(getRuntimeProfile({})).toBe("prod")
    expect(getDataRootName({})).toBe(".kanna")
    expect(getDataDir("/tmp/home", {})).toBe("/tmp/home/.kanna/data")
    expect(getDataDirDisplay({})).toBe("~/.kanna/data")
    expect(getKeybindingsFilePath("/tmp/home", {})).toBe("/tmp/home/.kanna/keybindings.json")
    expect(getKeybindingsFilePathDisplay({})).toBe("~/.kanna/keybindings.json")
  })

  test("switches to dev paths for the dev profile", () => {
    const env = { KANNA_RUNTIME_PROFILE: "dev" }

    expect(getRuntimeProfile(env)).toBe("dev")
    expect(getDataRootName(env)).toBe(".kanna-dev")
    expect(getDataDir("/tmp/home", env)).toBe("/tmp/home/.kanna-dev/data")
    expect(getDataDirDisplay(env)).toBe("~/.kanna-dev/data")
    expect(getKeybindingsFilePath("/tmp/home", env)).toBe("/tmp/home/.kanna-dev/keybindings.json")
    expect(getKeybindingsFilePathDisplay(env)).toBe("~/.kanna-dev/keybindings.json")
  })
})
