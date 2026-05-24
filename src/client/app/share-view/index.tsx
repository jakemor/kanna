import { createRoot } from "react-dom/client"
import type { ChatSnapshot } from "../../../shared/session-share/types"
import { ShareViewPage } from "./ShareViewPage"

// TODO(task-19): register `share-view` as a bundler entry so this file
// resolves at `/assets/share-view/main.js`. Until then the file exists for
// future wire-up + tests; the server already references the asset path.

const raw = document.getElementById("__SHARE_SNAPSHOT__")?.textContent
if (!raw) throw new Error("missing snapshot payload")
const snapshot = JSON.parse(raw) as ChatSnapshot
const mount = document.getElementById("share-view")
if (!mount) throw new Error("missing #share-view mount node")
createRoot(mount).render(<ShareViewPage snapshot={snapshot} />)
