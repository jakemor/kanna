import { readdirSync } from "node:fs"

/**
 * Preloaded by `bun test` (bunfig.toml). Fails the run up front when the test
 * process already holds too many file descriptors for spawning to work.
 *
 * Bun 1.3 keeps a descriptor open for every folder it walks looking for test
 * files, and it walks every folder in the repo that isn't hidden or
 * node_modules, ignored ones included. A spawned child's descriptor limit is
 * macOS's OPEN_MAX (10240), so once the parent's pipe descriptors are
 * numbered past that the child's stdout is invalid: `git status` exits 0 with
 * no output, and a hundred git-backed tests fail with no hint why. It
 * happened when Xcode's derived data (tens of thousands of folders) sat in
 * ios/build; it now lives in ios/.build.
 */
const LIMIT = 8000

const highest = Math.max(...readdirSync("/dev/fd").map(Number))
if (highest > LIMIT) {
  throw new Error(
    `bun test holds file descriptors up to ${highest} before any test runs, so spawned processes ` +
      `will get no stdout. A large folder in the repo that isn't hidden (build output, a copied ` +
      `checkout) is being walked for test files: move it out or into a dot-folder.`,
  )
}
