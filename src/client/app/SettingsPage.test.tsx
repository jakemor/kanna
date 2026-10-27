import { afterEach, describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RefreshCw } from "lucide-react"
import {
  ChangelogSection,
  fetchGithubReleases,
  formatPublishedDate,
  getCachedChangelog,
  getKeybindingsSubtitle,
  loadChangelog,
  resetSettingsPageChangelogCache,
  resolveChatBrowserNotificationPreferenceAfterPermission,
  resolveSettingsSectionId,
  setCachedChangelog,
  SettingsSidebarHeading,
  shouldPreviewChatSoundChange,
  SkillsSection,
} from "./SettingsPage"
import { SettingsActionButton } from "./settings/shared"
import type { UpdateSnapshot } from "../../shared/types"
import { LabsSection } from "./settings/LabsSection"

const SAMPLE_RELEASES = [
  {
    id: 1,
    name: "v0.8.1",
    tag_name: "v0.8.1",
    html_url: "https://github.com/jakemor/kanna/releases/tag/v0.8.1",
    published_at: "2026-03-19T16:53:08Z",
    body: "## Improvements\n- Better cursor color",
    prerelease: false,
    draft: false,
  },
  {
    id: 2,
    name: null,
    tag_name: "v0.9.0-beta.1",
    html_url: "https://github.com/jakemor/kanna/releases/tag/v0.9.0-beta.1",
    published_at: "2026-03-20T12:00:00Z",
    body: "",
    prerelease: true,
    draft: false,
  },
]

afterEach(() => {
  resetSettingsPageChangelogCache()
})

function createUpdateSnapshot(overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    status: "available",
    updateAvailable: true,
    lastCheckedAt: 123,
    error: null,
    installAction: "restart",
    reloadRequestedAt: null,
    ...overrides,
  }
}

describe("nightly status in Labs", () => {
  const cases: Array<[UpdateSnapshot["nightly"], string]> = [
    [undefined, "Latest nightly not checked yet"],
    [{ status: "checking", latestCommitSha: null, lastCheckedAt: null, error: null }, "Checking latest nightly…"],
    [{ status: "up_to_date", latestCommitSha: "abc1234", lastCheckedAt: 123, error: null }, "Latest nightly installed"],
    [{ status: "available", latestCommitSha: "def5678", lastCheckedAt: 123, error: null }, "New nightly available"],
    [{ status: "error", latestCommitSha: null, lastCheckedAt: 123, error: "GitHub unavailable" }, "Could not check latest nightly"],
  ]

  test.each(cases)("uses the nightly result even when npm is up to date: %j", (nightly, label) => {
    const html = renderToStaticMarkup(
      <LabsSection
        appVersion="0.69.0"
        state={{
          appSettings: null,
          updateSnapshot: createUpdateSnapshot({
            currentVersion: "0.69.0-nightly.abc1234", status: "up_to_date", updateAvailable: false, nightly,
          }),
          handleWriteAppSettings: async () => {},
          handleInstallNightly: async () => {},
          handleInstallStable: async () => {},
          handleCheckForUpdates: async () => {},
        }}
      />
    )
    expect(html).toContain(label)
    expect(html).toContain('role="status"')
    if (nightly?.status === "available") {
      expect(html).not.toContain("Check again")
    } else {
      expect(html).toContain("Check again")
    }
    if (nightly?.latestCommitSha && nightly.lastCheckedAt) {
      expect(html).toContain(`<p class="whitespace-nowrap">Latest: <code>${nightly.latestCommitSha.slice(0, 7)}</code> as of ${new Date(nightly.lastCheckedAt).toLocaleTimeString()}</p>`)
      expect(html).not.toContain("Last checked")
    }
    if (nightly?.status === "up_to_date") {
      expect(html).not.toContain("Build latest")
    } else {
      expect(html).toContain("Build latest")
    }
    if (nightly?.status !== "up_to_date") expect(html).not.toContain("Latest nightly installed")
  })
})

describe("fetchGithubReleases", () => {
  test("filters draft releases and sends the GitHub accept header", async () => {
    let requestedUrl = ""
    let requestedAcceptHeader = ""

    const releases = await fetchGithubReleases(async (input, init) => {
      requestedUrl = String(input)
      requestedAcceptHeader = String(new Headers(init?.headers).get("Accept"))

      return new Response(JSON.stringify([
        SAMPLE_RELEASES[0],
        { ...SAMPLE_RELEASES[1], draft: true },
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })

    expect(requestedUrl).toBe("https://api.github.com/repos/jakemor/kanna/releases")
    expect(requestedAcceptHeader).toBe("application/vnd.github+json")
    expect(releases).toEqual([SAMPLE_RELEASES[0]])
  })

  test("throws on non-200 responses", async () => {
    await expect(fetchGithubReleases(async () => new Response("nope", { status: 403 }))).rejects.toThrow(
      "GitHub releases request failed with status 403"
    )
  })
})

describe("changelog cache", () => {
  test("reuses cached releases inside the ttl window", () => {
    const originalNow = Date.now
    Date.now = () => 1_000

    setCachedChangelog([SAMPLE_RELEASES[0]])
    expect(getCachedChangelog()).toEqual([SAMPLE_RELEASES[0]])

    Date.now = () => 1_000 + 4 * 60 * 1000
    expect(getCachedChangelog()).toEqual([SAMPLE_RELEASES[0]])

    Date.now = originalNow
  })

  test("expires cached releases after the ttl window", () => {
    const originalNow = Date.now
    Date.now = () => 2_000

    setCachedChangelog([SAMPLE_RELEASES[0]])
    Date.now = () => 2_000 + 5 * 60 * 1000 + 1

    expect(getCachedChangelog()).toBeNull()

    Date.now = originalNow
  })

  test("force refresh bypasses the in-memory cache", async () => {
    setCachedChangelog([SAMPLE_RELEASES[0]])

    const releases = await loadChangelog({
      force: true,
      fetchImpl: async () => new Response(JSON.stringify([SAMPLE_RELEASES[1]]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    })

    expect(releases).toEqual([SAMPLE_RELEASES[1]])
  })
})

describe("resolveSettingsSectionId", () => {
  test("accepts known settings sections", () => {
    expect(resolveSettingsSectionId("general")).toBe("general")
    expect(resolveSettingsSectionId("providers")).toBe("providers")
    expect(resolveSettingsSectionId("changelog")).toBe("changelog")
    expect(resolveSettingsSectionId("keybindings")).toBe("keybindings")
    expect(resolveSettingsSectionId("skills")).toBe("skills")
  })

  test("rejects unknown settings sections", () => {
    expect(resolveSettingsSectionId("page-1")).toBeNull()
    expect(resolveSettingsSectionId("page-2")).toBeNull()
    expect(resolveSettingsSectionId("page-3")).toBeNull()
    expect(resolveSettingsSectionId("nope")).toBeNull()
    expect(resolveSettingsSectionId(undefined)).toBeNull()
  })

  test("This Mac exists only in Kanna for Mac", () => {
    expect(resolveSettingsSectionId("mac")).toBeNull()
  })
})

describe("SkillsSection", () => {
  test("renders the skills.sh search box and installed section", () => {
    const html = renderToStaticMarkup(
      <SkillsSection
        state={{
          connectionStatus: "connected",
          socket: {
            command: async () => ({ skills: [] }),
          } as never,
        }}
      />
    )

    expect(html).toContain("No global skills installed yet")
    expect(html).toContain("Add skills from skills.sh")
    expect(html).toContain("searchbox")
  })
})

describe("getKeybindingsSubtitle", () => {
  test("renders the active keybindings path", () => {
    expect(getKeybindingsSubtitle("~/.kanna-dev/keybindings.json")).toBe(
      "Edit global app shortcuts stored in ~/.kanna-dev/keybindings.json."
    )
  })
})

describe("shouldPreviewChatSoundChange", () => {
  test("previews only when the selected value actually changes", () => {
    expect(shouldPreviewChatSoundChange("always", "always")).toBe(false)
    expect(shouldPreviewChatSoundChange("always", "never")).toBe(true)
    expect(shouldPreviewChatSoundChange("never", "unfocused")).toBe(true)
    expect(shouldPreviewChatSoundChange("funk", "glass")).toBe(true)
  })
})

describe("resolveChatBrowserNotificationPreferenceAfterPermission", () => {
  test("keeps enabled browser notification preferences only after permission is granted", () => {
    expect(resolveChatBrowserNotificationPreferenceAfterPermission("always", "granted")).toBe("always")
    expect(resolveChatBrowserNotificationPreferenceAfterPermission("unfocused", "granted")).toBe("unfocused")
  })

  test("falls back to never when browser notifications cannot be used", () => {
    expect(resolveChatBrowserNotificationPreferenceAfterPermission("always", "denied")).toBe("never")
    expect(resolveChatBrowserNotificationPreferenceAfterPermission("unfocused", "unsupported")).toBe("never")
    expect(resolveChatBrowserNotificationPreferenceAfterPermission("always", "default")).toBe("never")
  })

  test("keeps never without requiring browser permission", () => {
    expect(resolveChatBrowserNotificationPreferenceAfterPermission("never", "denied")).toBe("never")
  })
})

describe("SettingsSidebarHeading", () => {
  const render = (sidebarCollapsed: boolean) => renderToStaticMarkup(
    <SettingsSidebarHeading sidebarCollapsed={sidebarCollapsed} onExpandSidebar={() => {}} />
  )

  test("with the sidebar collapsed, puts the expand controls above the heading, in its flow", () => {
    const html = render(true)
    expect(html).toContain('title="Expand sidebar"')
    expect(html.indexOf('title="Expand sidebar"')).toBeLessThan(html.indexOf(">Settings<"))
  })

  test("hides the expand controls in the Mac app, which pins its own toggle", () => {
    const html = render(true)
    const controls = html.slice(0, html.indexOf('title="Expand sidebar"'))
    expect(controls).toContain("mac-app:hidden")
  })

  test("pulls the controls out of the column's padding onto the open sidebar's logo", () => {
    const html = render(true)
    const controls = html.slice(0, html.indexOf('title="Expand sidebar"'))
    expect(controls).toContain("-mt-[17.5px]")
    expect(controls).toContain("-ml-1")
  })

  test("with the sidebar open, shows only the heading", () => {
    const html = render(false)
    expect(html).not.toContain("Expand sidebar")
    expect(html).toContain(">Settings<")
  })
})

describe("SettingsActionButton", () => {
  test("renders the label and icon as plain text, with no box", () => {
    const html = renderToStaticMarkup(
      <SettingsActionButton icon={<RefreshCw />}>
        Check for updates
      </SettingsActionButton>
    )

    expect(html).toContain("Check for updates")
    expect(html).toContain("lucide-refresh-cw")
    expect(html).toContain("text-foreground")
    expect(html).not.toContain("border")
    expect(html).not.toContain("bg-")
  })

  test("tints the prominent action with the brand colour", () => {
    const html = renderToStaticMarkup(
      <SettingsActionButton prominent>
        Update
      </SettingsActionButton>
    )

    expect(html).toContain("Update")
    expect(html).toContain("text-logo")
  })
})

describe("ChangelogSection", () => {
  test("renders version highlights, release cards, markdown, links, and prerelease badges", () => {
    const html = renderToStaticMarkup(
      <ChangelogSection
        status="success"
        releases={SAMPLE_RELEASES}
        error={null}
        onRetry={() => {}}
        updateSnapshot={createUpdateSnapshot({ latestVersion: "0.8.1", currentVersion: "0.8.1" })}
        currentVersion="1.0.0"
        onInstallUpdate={() => {}}
        onCheckForUpdates={() => {}}
      />
    )

    expect(html).not.toContain("You are currently running this version of Kanna.")
    expect(html).toContain("Current")
    expect(html).toContain("Update")
    expect(html).toContain("Update")
    expect(html).toContain("v0.8.1")
    expect(html).toContain("Better cursor color")
    expect(html).toContain('aria-label="View release on GitHub"')
    expect(html).toContain("https://github.com/jakemor/kanna/releases/tag/v0.8.1")
    expect(html).toContain("Prerelease")
    expect(html).toContain("No release notes were provided.")
    expect(html).toContain(formatPublishedDate("2026-03-19T16:53:08Z"))
    expect(html).not.toContain("View on GitHub")
  })

  test("renders an error state with retry action", () => {
    const html = renderToStaticMarkup(
      <ChangelogSection
        status="error"
        releases={[]}
        error="GitHub said no"
        onRetry={() => {}}
        updateSnapshot={createUpdateSnapshot({ updateAvailable: false, status: "error", error: "GitHub said no" })}
        currentVersion="1.0.0"
        onInstallUpdate={() => {}}
        onCheckForUpdates={() => {}}
      />
    )

    expect(html).toContain("Could not load changelog")
    expect(html).toContain("GitHub said no")
    expect(html).toContain("Retry")
  })

  test("renders check-for-updates when no update is available", () => {
    const html = renderToStaticMarkup(
      <ChangelogSection
        status="success"
        releases={SAMPLE_RELEASES}
        error={null}
        onRetry={() => {}}
        updateSnapshot={createUpdateSnapshot({
          latestVersion: "1.0.0",
          status: "up_to_date",
          updateAvailable: false,
        })}
        currentVersion="1.0.0"
        onInstallUpdate={() => {}}
        onCheckForUpdates={() => {}}
      />
    )

    expect(html).toContain("Check for updates")
    expect(html).not.toContain(">Update<")
  })

  test("disables the update action while updating", () => {
    const html = renderToStaticMarkup(
      <ChangelogSection
        status="success"
        releases={SAMPLE_RELEASES}
        error={null}
        onRetry={() => {}}
        updateSnapshot={createUpdateSnapshot({
          latestVersion: "0.8.1",
          status: "restart_pending",
        })}
        currentVersion="1.0.0"
        onInstallUpdate={() => {}}
        onCheckForUpdates={() => {}}
      />
    )

    expect(html).toContain("disabled")
    expect(html).toContain("Updating")
  })
})
