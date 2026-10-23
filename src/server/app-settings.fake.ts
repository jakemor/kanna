import { Effect, Stream, SubscriptionRef } from "effect"
import type { AppSettingsPatch, AppSettingsSnapshot } from "../shared/types"
import { defaultAppSettingsSnapshot, type AppSettings } from "./app-settings"

/**
 * An in-memory `AppSettings` for tests that hand one to the router, starting
 * from the defaults with `initial` laid over them. Writes merge into the
 * snapshot (without the real normalization) and emit on `changes`, like the
 * real service.
 */
export function makeFakeAppSettings(
  initial: Partial<AppSettingsSnapshot> = {},
  options: { analyticsUserId?: string } = {},
): AppSettings["Service"] {
  const ref = Effect.runSync(SubscriptionRef.make<AppSettingsSnapshot>({
    ...defaultAppSettingsSnapshot("/tmp/kanna-fake-settings.json", "/tmp"),
    ...initial,
  }))
  const writePatch = (patch: AppSettingsPatch) =>
    SubscriptionRef.updateAndGet(ref, (current): AppSettingsSnapshot => ({
      ...current,
      ...patch,
      terminal: { ...current.terminal, ...patch.terminal },
      editor: { ...current.editor, ...patch.editor },
      transcript: { ...current.transcript, ...patch.transcript },
      paneVisibility: { ...current.paneVisibility, ...patch.paneVisibility },
      providerDefaults: current.providerDefaults,
    }))
  return {
    filePath: "/tmp/kanna-fake-settings.json",
    snapshot: SubscriptionRef.get(ref),
    state: SubscriptionRef.get(ref).pipe(Effect.map(({ devbox: _devbox, installedEditors: _editors, installedTerminals: _terminals, ...state }) => ({
      ...state,
      analyticsUserId: options.analyticsUserId ?? "anon_fake",
    }))),
    changes: SubscriptionRef.changes(ref).pipe(Stream.drop(1)),
    reload: Effect.void,
    write: (value) => writePatch({ analyticsEnabled: value.analyticsEnabled }),
    writePatch,
    setInstalledEditors: (installedEditors) => SubscriptionRef.update(ref, (current) => ({ ...current, installedEditors })),
    setInstalledTerminals: (installedTerminals) => SubscriptionRef.update(ref, (current) => ({ ...current, installedTerminals })),
  }
}
