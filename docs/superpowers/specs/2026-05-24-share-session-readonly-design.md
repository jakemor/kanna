# Share Session Read-Only (Public View) — Design

- Date: 2026-05-24
- Status: Proposed
- Owner: cuongtranba
- Related C3: new component `c3-228 session-share`; touches `c3-115`, `c3-116`, `c3-202`, `c3-203`, `c3-205`, `c3-206`, `c3-207`, `c3-218`, `c3-223`, `c3-306`

## Goal

Let the owner of a Kanna chat session generate a public, read-only URL that any browser on the internet can open to view the chat's transcript, tool calls, diffs, and terminal output — without authenticating to Kanna and without being able to mutate state.

## Locked Requirements

These come from brainstorming and are not up for re-negotiation in implementation:

| Topic | Decision |
| --- | --- |
| Transport | Cloudflare tunnel + token. URL shape: `<tunnel-base>/share/<token>`. |
| View scope | Full chat page UI, read-only. Composer hidden, sidebar hidden, settings inaccessible. |
| Liveness | Snapshot at mint time. No live updates. Viewer refresh does not re-fetch newer state. |
| Lifecycle | Tokens have a TTL. Default TTL is configurable in Settings (default 24h). Owner can revoke at any time. |
| Redaction | None. Snapshot contains everything the owner sees. |
| Tunnel absent | Mint is blocked with `NO_TUNNEL`. UI shows a CTA pointing to tunnel setup. No implicit tunnel spawn. |
| UI entry point | Share button in chat header (`c3-115`). Popover for mint/copy/revoke/expiry. |

Out of scope (explicit non-goals):

- Live updates to the viewer
- Multiple tokens per chat / per-recipient audit
- Redaction or secret masking
- Auto-starting a Cloudflare tunnel
- Uploading the snapshot to an external hosted service
- Allowing the viewer to edit, comment, or interact

## Architecture

A new server component `c3-228 session-share` owns the entire feature. It is a sibling of `c3-218 share` (which manages the whole-Kanna Cloudflare tunnel) — different scope, no merge.

```
chat header (c3-115) ── ws ──▶ ws-router (c3-208)
                                      │
                                      ▼
                            session-share (c3-228) ──▶ event-store (c3-206)
                                      │              ──▶ read-models  (c3-207)
                                      │
                                      ▼
                            app-settings (default TTL)

HTTP /share/<token>  ──▶ http-ws-server (c3-202)
                                      │  bypass auth (c3-203)
                                      ▼
                            session-share.serveSnapshot()
                                      ▼
                            client share-view route (new under c3-1)
```

Tunnel base URL is read from `c3-218` / `c3-223`. If neither is up, mint is refused.

State model:

- Tokens are projected from a new event family written to the event log (`c3-206`), satisfying the existing event-sourcing ref.
- Snapshot bytes are stored as JSON files under `~/.kanna/shares/<tokenId>.json` (file mode `0600`), satisfying the local-first-data ref.
- TTL is the `expiresAt` field on the projection. Expired tokens resolve to a `410` error page; they remain in the projection until the sweep reclaims their disk.

## Components and File Layout

### Server (`c3-2`)

```
src/server/session-share/
  index.ts                     # public API: mintToken, revokeToken, getShare, serveSnapshot
  token.ts                     # token generation (256-bit random, base64url)
  snapshot-builder.ts          # event log → frozen ChatSnapshot JSON via read-models
  snapshot-store.adapter.ts    # ~/.kanna/shares/<token>.json read/write (side-effect adapter)
  share-projection.ts          # event-store projector: token_minted / token_revoked → in-mem map
  http-routes.ts               # GET /share/:token → snapshot JSON + share-view bundle
  session-share.test.ts
  snapshot-builder.test.ts
  snapshot-store.adapter.test.ts
  share-projection.test.ts
  http-routes.test.ts
  token.test.ts
```

### Shared (`c3-3`)

```
src/shared/session-share/
  types.ts          # ShareToken, ChatSnapshot, MintRequest, MintResponse, ShareError
  protocol.ts       # ws envelopes: share_mint, share_revoke, share_list
```

### Client (`c3-1`)

```
src/client/components/share/
  ShareButton.tsx            # header entry (chat-page)
  SharePopover.tsx           # mint / copy / revoke / expiry UI
  share-store.ts             # zustand store keyed by chatId; uses EMPTY const for stable refs
  ShareButton.test.tsx
  SharePopover.test.tsx
  share-store.test.ts

src/client/app/share-view/
  ShareViewPage.tsx          # public read-only chat page (no auth, no composer, no ws)
  routes.tsx                 # /share/:token route registration
  ShareViewPage.test.tsx

src/client/components/settings/
  ShareDefaultTtl.tsx        # default TTL setting row in c3-116
```

### Event-store additions (`c3-205`)

| Event kind | Payload |
| --- | --- |
| `share.token_minted` | `{ tokenId, chatId, snapshotPath, expiresAt, createdAt, createdBy }` |
| `share.token_revoked` | `{ tokenId, revokedAt }` |

### App-settings additions (`c3-216`)

- `shareDefaultTtlHours: number` (default `24`)

### c3 doc work (mandatory)

- New component `c3-228 session-share` under `c3-2` with full schema (Goal, Parent Fit, Purpose, Foundational Flow, Business Flow, Governance, Contract, Change Safety, Derived Materials).
- Update `c3-202` (new public `/share/*` route).
- Update `c3-203` (auth bypass rule for `/share/*` and `/assets/share-view/*`).
- Update `c3-205` (new event kinds in the union).
- Update `c3-115` (Share button in chat header).
- Update `c3-116` (default-TTL settings row).
- Update `c3-306` (share-shared types added).
- New `adr-YYYYMMDD-session-share` (ADR-first per c3 change op).

## Data Flows

### Mint (owner clicks Share)

```
client ShareButton
  → ws share_mint { chatId, ttlHours? }
  → ws-router → session-share.mintToken()
     1. assert chatId exists and the caller is the authenticated owner
     2. assert tunnel base URL available (c3-218 / c3-223); missing → ShareError.NO_TUNNEL
     3. ttl = ttlHours ?? settings.shareDefaultTtlHours
     4. snapshot = snapshot-builder.build(chatId)
     5. tokenId = token.generate()             (32 bytes, base64url)
     6. snapshot-store.write(tokenId, snapshot) (0600)
     7. event-store.append(share.token_minted)
     8. share-projection updates its in-mem map
  ← MintResponse { url: "<base>/share/<tokenId>", expiresAt }
client SharePopover renders url + copy button + expiry
```

### View (public viewer hits URL)

```
GET /share/:token   (via tunnel → c3-202)
  → c3-203 auth: path matches /share/* → bypass owner auth
  → session-share.serveSnapshot(token)
     a. lookup projection by tokenId
        miss → 404 "Share not found"
        revoked → 410 "Share revoked"
        expired → 410 "Share expired"
        hit → continue
     b. snapshot-store.read(tokenId) → ChatSnapshot JSON
     c. respond with share-view HTML bundle + snapshot inline as JSON
  → client ShareViewPage renders read-only chat page from snapshot
     - composer hidden, no ws connection, no sidebar, no settings access
     - tool calls / messages / diffs rendered via existing messages-renderer (c3-114)
```

### Revoke

```
client SharePopover revoke click
  → ws share_revoke { tokenId }
  → session-share.revokeToken()
     1. event-store.append(share.token_revoked)
     2. projection marks revoked
     3. snapshot-store.delete(tokenId)
  ← ok
```

### Expiry

- No background timer per share. Lazy check: every `getShare()` compares `expiresAt <= now` and returns `EXPIRED`.
- Daily sweep: on server boot and every 24h thereafter (single `setInterval`), iterate the projection; for each expired token call `snapshot-store.delete(tokenId)`. No event is written — state stays "minted, just expired" so the 410 page can keep responding.

### Snapshot Shape (frozen)

```
ChatSnapshot v1 {
  version: 1
  chatMeta: { id, title, model, createdAt }
  messages: TranscriptEntry[]    // user_prompt, assistant_text, tool_call, tool_result, diff, terminal_chunk
  attachmentsManifest: { filename, sizeBytes, inlineBase64? }[]
}
```

The snapshot is fully self-contained — the share-view route does no live event-store reads.

## Error Handling and Security

### Auth model

- `/share/:token` and `/assets/share-view/*` are the ONLY unauthenticated paths.
- Auth bypass is implemented as a path-prefix check in `c3-203` (`isPublicSharePath(url)`), not a header check — viewers present no credentials.
- The token IS the credential. 256 bits (32 random bytes, base64url) is unguessable. A per-IP rate limit of 60 req/min on `/share/*` is added as cheap bandwidth insurance.
- Mint and revoke ws envelopes are gated by normal owner auth. Viewers cannot mint or revoke.

### Error taxonomy (`ShareError` discriminated union)

| Kind | HTTP (if applicable) | Source | UI |
| --- | --- | --- | --- |
| `no_tunnel` | n/a (ws) | mint | CTA in popover: "Start tunnel to share" linking c3-218 setup |
| `chat_not_found` | n/a (ws) | mint | toast |
| `snapshot_too_large` | n/a (ws) | mint | toast |
| `snapshot_write_failed` | n/a (ws) | mint | toast + log |
| `not_found` | 404 | view | static page "Share not found" |
| `revoked` | 410 | view | static page "Share revoked by owner" |
| `expired` | 410 | view | static page "Share expired on \<date\>" |
| `snapshot_read_failed` | 500 | view | static page + log |

Error pages are server-rendered HTML strings — no SPA load on failure cases (avoids leaking client bundle paths to unauthenticated probes).

### Strong-typing seal

All wire shapes live in `src/shared/session-share/types.ts` as discriminated unions. `ShareError` is `{kind: "no_tunnel"} | {kind: "expired", expiredAt} | …`. No `any`, no untyped maps — per `rule-strong-typing`.

### Side-effect seal

`snapshot-store.adapter.ts` is the only file in `c3-228` that touches `node:fs`. All paths are derived from `paths-config` (`c3-204`) → `kannaDir/shares/<tokenId>.json`. File mode `0600` to protect snapshot contents on shared boxes. The adapter filename suffix matches the `.adapter.ts` side-effect convention so ESLint allows it.

### Snapshot disk caps

- Per-snapshot soft cap: 10 MB. If exceeded, `snapshot-builder` strips `terminal_chunk` bodies and `diff` bodies (replaced with `{kind:"omitted", reason:"too_large"}`) and retries.
- Per-snapshot hard cap: 50 MB. Exceeded → mint fails with `snapshot_too_large`.
- Total shares directory cap: 1 GB. Sweep evicts oldest expired first; if still over budget, mint fails until the owner revokes.

### Race conditions

- Revoke during inflight view: projection check is in-process; revoke wins because it appends the event and deletes the file before responding. A view that already opened the file stream continues — that's fine; the viewer was already entitled to read that snapshot at request time.
- Boot replay: projection is rebuilt from the event log. Missing snapshot file (manual fs delete) → projection self-heals by marking that token as `revoked` and emitting a log warning.

### Cancellation

Mint is a single ws RTT — no cancellation needed. Sweep is non-blocking.

### Logging

Mint and revoke emit analytics events `share.minted` / `share.revoked` with `{chatId, tokenIdHash}`. View hits log at debug level with `{tokenIdHash, status}`. No PII, no full token in logs.

## Testing Strategy

All tests are colocated `*.test.ts` per `rule-colocated-bun-test`.

### Server unit

- `token.test.ts` — entropy and URL-safe charset.
- `snapshot-builder.test.ts` — event log fixture → snapshot golden; covers `user_prompt`, `assistant_text`, `tool_call`, `tool_result`, `diff`, `terminal_chunk`, attachments small / large / omitted; `version: 1` pinned.
- `snapshot-store.adapter.test.ts` — write/read/delete round-trip, `0600` mode, paths-config integration.
- `share-projection.test.ts` — replay mints + revokes + expiry; missing-file self-heal.
- `session-share.test.ts` — `mintToken`: success, `NO_TUNNEL`, `CHAT_NOT_FOUND`, `SNAPSHOT_TOO_LARGE`; `revokeToken`: success + idempotent second call; `getShare`: hit, `NOT_FOUND`, `REVOKED`, `EXPIRED`.
- `http-routes.test.ts` — `/share/:token` 200 / 404 / 410 / 500 paths; rate-limit 60/min; auth-bypass scope (only `/share/*` and asset prefix bypass; other paths still gated).

### Server integration

- Spin up the Bun HTTP server in a test, stub tunnel base URL, mint via ws, GET `/share/<token>` over plain HTTP with no auth header, assert snapshot HTML + JSON shape.
- Boot replay: pre-seed the event log on disk, restart the server, assert the projection is rebuilt and the previously-minted token still resolves.

### Client

- `ShareButton.test.tsx` — disabled when no tunnel; enabled mint click.
- `SharePopover.test.tsx` — copy URL, revoke flow, expiry display, NO_TUNNEL CTA.
- `ShareViewPage.test.tsx` — renders snapshot, composer absent, sidebar absent, no ws connect, no settings link.
- `share-store.test.ts` — stable selectors using `EMPTY` const pattern (per the render-loop regression rule in CLAUDE.md).
- `renderForLoopCheck` smoke run on `ShareViewPage`.

### E2E

If the existing Playwright harness covers chat flows:

- Owner mints a share, opens an incognito tab against `/share/<token>`, asserts transcript visible and composer absent.
- Owner revokes; incognito refresh returns `410`.

### Verify gates

- `bun run lint` clean (warning cap unchanged; new IO confined to `*.adapter.ts`).
- `bun test` green.
- `c3x check` clean after doc updates.

## Rollout

- Single PR (no feature flag). The feature is purely additive: no existing route or auth path changes shape; only a new path-prefix bypass and new event kinds.
- Settings default `shareDefaultTtlHours = 24` on first boot. Existing event logs replay cleanly (no `share.token_*` events from past sessions).
- Wiki: a new page at `wiki/src/content/docs/sharing/session-share.mdx` with one screenshot of the popover. The env-var table does not need regeneration — no new env vars.
- ADR: `c3x add adr session-share` starts in `proposed`, moves to `accepted` once this design is signed off, then `implemented` once the PR merges.

## Open Questions

None at design time. Brainstorming covered all forks. Surface any new ones during implementation as ADR addenda.
