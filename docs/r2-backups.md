# Chat history backups to Cloudflare R2

Open **Settings → Backups → Use Cloudflare CLI**. Kanna uses the Wrangler login on the machine running the server. Select an account, select an existing private R2 bucket (default jurisdiction), and save. No Kanna OAuth client registration is needed for this flow.

Install Wrangler on the server's PATH and sign in once with `wrangler login`. On a recent Wrangler version, `wrangler login --device --browser=false` lets you authorize on a phone or another computer without a localhost callback. Older versions without `--device` must be updated to use that login flow; an existing login already works with `wrangler auth token --json`.

Kanna calls `wrangler whoami --json` for accounts and `wrangler auth token --json` for refreshed credentials. Tokens are cached in server memory for up to five minutes, reloaded before each backup and after an HTTP 401, and never copied into Kanna's saved configuration. Disconnecting Kanna does not log Wrangler out or affect other CLI workflows.

If you prefer a manually configured connection, enter the account ID and bucket name and expand **Use an API token instead**. Use R2 object read/write and bucket read permissions scoped to the destination account/bucket. S3 access-key/secret pairs are not API bearer tokens.

**Save and enable backups** verifies access to the bucket and starts the first backup. Choose every 15 minutes, hourly or daily. Kanna must be running; overdue backups resume on startup. A failed backup retries after five minutes or sooner. **Back up now** also works while the schedule is paused. Errors and the last successful run appear in settings. Disconnect removes locally stored credentials and disables the schedule; revoke the application's grant in Cloudflare as well if you want to withdraw its access there.

## OAuth setup for operators

Cloudflare requires a registered OAuth client. Kanna does not borrow Wrangler's client identity. Register a client in **Manage Account → OAuth clients** with Authorization Code, refresh-token support, PKCE S256, and the R2 object write/read and bucket read scopes shown by Cloudflare. For a distributed desktop/self-hosted client use token authentication `none`; a server-owned confidential client can use `client_secret_post`. A private client works for members of its owning Cloudflare account; making a client available to other accounts requires Cloudflare's public-client registration/domain verification.

Configure the server environment:

```sh
# For an HTTPS reverse proxy, set the exact browser origin (including port):
KANNA_PUBLIC_ORIGIN='https://your-kanna-host'
KANNA_CF_OAUTH_CLIENT_ID='<registered client ID>'
KANNA_CF_OAUTH_REDIRECT_URI='https://your-kanna-host/settings/backups'
KANNA_CF_OAUTH_SCOPES='<space-separated R2 scope IDs from your registered client>'
# Only for a confidential client using client_secret_post:
# KANNA_CF_OAUTH_CLIENT_SECRET='<client secret>'
```

Register the exact redirect URI with Cloudflare and open Kanna at that origin. `KANNA_PUBLIC_ORIGIN` lets password authentication and backup requests recognize that specific HTTPS origin without trusting arbitrary forwarded headers. Include a nonstandard port, such as `:8443`, in both variables when used. Kanna adds `offline_access`, uses browser-bound state and PKCE, and retains/rotates refresh tokens on the server. HTTP callbacks are accepted only for `localhost` and `127.0.0.1`. For a remote HTTP-only deployment, use the API-token option or an existing HTTPS Kanna endpoint. No localhost listener is opened on the browser's device.

Cloudflare references: [client registration](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/), [OAuth endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/), [R2 object upload API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/upload/).

## Storage and efficiency

Each runtime profile has its own backup configuration under its data directory (`backups/state.json`). The containing directory is mode `0700` and the atomically replaced state file is mode `0600`. For the optional API-token or custom-OAuth connection, tokens are stored in that protected file, not encrypted with an external keychain. Wrangler connections store only the auth method, leaving credential storage and refresh to Wrangler. They never appear in settings responses or backup objects. Keep access to the Kanna server limited to trusted users, as with its other settings.

A capture pins open files and their byte lengths on the transcript write queue, then copies their contents asynchronously after releasing the queue. Later appends are excluded, and pinned files survive deletion or atomic replacement during capture. Capture supports macOS and Linux; Linux requires accessible mounted procfs at `/proc/self/fd` and fails explicitly when unavailable. Pinning needs one file descriptor per captured file; a descriptor-limit failure safely aborts the capture. It includes the history snapshot, transcript headers, full payload sidecars, transcript media, sidebar order, and available files in each project's `.kanna/uploads`. It excludes settings, provider credentials, backup credentials, arbitrary project files and source repositories. Chats deleted before the first successful backup cannot be recovered by this feature.

Files are split into 4 MiB chunks, SHA-256 addressed and gzip compressed. Only chunks not already uploaded to this destination are sent; appending to a long transcript generally uploads only its changed tail. Capturing and hashing still reads the local history each run and requires local scratch space. The upload cache survives restarts and resets when the destination changes. Requests have timeouts, transient HTTP failures have bounded retries, and runs cannot overlap.

The bucket contains:

```text
kanna/<installation-id>/
  chunks/<sha256>.gz
  snapshots/<timestamp>-<uuid>.json
  latest.json
```

Manifests record paths, byte sizes and ordered chunk hashes. A manifest is published only after all chunks have uploaded. Completed historical snapshots and chunks are retained indefinitely, so a later local deletion does not erase earlier backups. Do not delete chunk objects or apply expiring lifecycle rules to this prefix: snapshots share chunks. Storage charges can grow over time. The bucket remains private; Kanna does not configure public access.

## Restore and verify

Download the complete `kanna/<installation-id>/` prefix from your private bucket, preserving its layout. Use your R2/S3 tooling, or download the manifest and every chunk it references. From a Kanna checkout (or installed package directory), run:

```sh
bun src/server/restore-backup.ts /path/to/downloaded-prefix /path/to/new-restored-directory
# To select an older snapshot:
bun src/server/restore-backup.ts /path/to/downloaded-prefix /path/to/new-restored-directory /path/to/downloaded-prefix/snapshots/SNAPSHOT.json
```

The output directory must not exist. Restore validates paths, decompression limits, SHA-256 hashes and file sizes. It never overwrites live history and removes incomplete output on failure.

Stop Kanna before replacing its data. Keep a copy of the existing data directory, then move the recovered `snapshot.json`, `transcripts/`, `media/` and `sidebar-order.json` into a fresh data directory for the intended runtime profile. Do not merge old event logs into a recovered snapshot. Backups restore history, not running agent processes or provider login sessions.

Uploaded project files are under `project-uploads/<project-id>/`. Use `snapshot.json` to map project IDs to project paths; copy those files back into each project's `.kanna/uploads/` as needed. This manual step avoids overwriting working files or writing to arbitrary absolute paths from a backup. If the projects moved to a new machine/path, update their paths and attachment references before use. Reconnect Cloudflare in settings to resume backups after a fresh-machine restore.
