// Central registry of the raw `kanna:`-prefixed localStorage/sessionStorage keys
// used by the client. Zustand-persisted store names are intentionally not listed
// here — they live next to their `persist(...)` configs in the stores.

/** sessionStorage: current phase of a UI update/restart cycle. */
export const UI_UPDATE_RESTART_STORAGE_KEY = "kanna:ui-update-restart"

/** sessionStorage: timestamp of the last server-initiated reload request we handled. */
export const UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY = "kanna:last-update-reload-request"

/** localStorage: persisted sidebar width in pixels. */
export const SIDEBAR_WIDTH_STORAGE_KEY = "kanna:sidebar-width"

/** localStorage: last action chosen in the open-external menu. */
export const OPEN_EXTERNAL_SELECT_STORAGE_KEY = "kanna:last-open-external"

/** localStorage: active sidebar view ("recents" | "projects") when the recent-chats Labs mode is on. */
export const SIDEBAR_VIEW_STORAGE_KEY = "kanna:sidebar-view"

/** localStorage: focus mode is on, so the sidebar shows only the open chat's project. */
export const SIDEBAR_FOCUS_MODE_STORAGE_KEY = "kanna:sidebar-focus-mode"

/** localStorage: transcript detail level, per chat, for the chats that left the default. */
export const TRANSCRIPT_DETAIL_STORAGE_KEY = "kanna:transcript-detail"

// Legacy setup-wizard markers. Onboarding progress is now machine-wide state
// in the server's settings file (`setupShown`/`setupCompleted`/`setupDismissed`
// on the app-settings snapshot) so a second browser — local or via the cloud
// tunnel — never re-runs a wizard this machine already finished. These keys are
// only read once, to migrate a pre-upgrade browser, then removed; see
// readLegacySetupFlagsPatch in app/useAppSettingsSync.ts.

/** localStorage (legacy): the setup wizard has been shown at least once. */
export const LEGACY_SETUP_SHOWN_STORAGE_KEY = "kanna:setup-shown"

/** localStorage (legacy): the setup wizard was completed (finished the last step). */
export const LEGACY_SETUP_COMPLETED_STORAGE_KEY = "kanna:setup-completed"

/** localStorage (legacy): the setup wizard was dismissed ("Set up later"). */
export const LEGACY_SETUP_DISMISSED_STORAGE_KEY = "kanna:setup-dismissed"
