# /release - Publish a new version to npm

## Description
Bump the package version, push to GitHub, and create a release with a structured changelog that triggers the npm publish workflow.

## Instructions

### Step 1: Analyze changes and recommend a version bump

Before prompting the user, do the following:

1. Read the current version from `package.json`.
2. Run `git log $(git describe --tags --abbrev=0)..HEAD --oneline` to see what's changed since the last release.
3. Based on the changes, decide your recommended version bump:
   - **patch** — bug fixes, typos, small tweaks
   - **minor** — new features, non-breaking enhancements
   - **major** — breaking changes, API changes, large rewrites
4. Calculate what the new version number would be for each option (patch, minor, major).

If the user passed an explicit version as an argument (e.g. `/release 0.27.0`), use that version directly — skip the recommendation logic and confirmation.

Otherwise, for **patch** and **minor** bumps, proceed automatically with your best recommendation — do NOT ask for confirmation. Just tell the user what you chose and why in a brief message before bumping.

For **major** bumps only, use the `AskUserQuestion` tool to confirm with the user before proceeding, since major versions indicate breaking changes.

### Step 2: Bump version and push

1. Run `npm version <patch|minor|major>` to bump `package.json` and create a git tag.
2. Run `git push && git push --tags` to push the commit and tag.

### Step 3: Build the changelog

Before creating the GitHub release, generate a structured changelog:

1. Read the last 2–3 releases with `gh release view <tag>` to understand existing style.
2. Get the commits in this release: `git log <previous-tag>..<new-tag> --oneline`.
3. For each commit, check if it's associated with a merged PR:
   - Use `gh pr list --search "<sha>" --state merged --json number,title,author` or the GitHub API.
   - If a PR exists, use its number, title, and author. Prefer linking to the PR.
   - If no PR exists, link to the commit and use the commit author.
4. If multiple commits belong to the same PR, group them into a single entry.
5. Categorize each change into one of the sections below.
6. **For user-facing changes (New Features and Improvements), read the actual source code** — don't just rely on commit messages. Understand what the feature does, how users interact with it, and why it matters. Write rich, detailed descriptions that explain the feature thoroughly.
7. Write each entry from the **user's perspective** — focus on what changed and why it matters, not how it was built.

### Changelog detail level

**User-facing changes (New Features, Improvements) should be detailed and thorough:**
- Read the relevant source code to understand the feature deeply
- Explain what the feature does, how users use it (CLI flags, UI interactions, etc.)
- Highlight security properties, performance characteristics, or other notable qualities
- Include code examples (e.g. CLI invocations) when they help explain usage
- If multiple features compose together in interesting ways, explain the composition
- Think of this as writing for someone evaluating whether to upgrade — sell the value

**Non-user-facing changes (Under the Hood) should remain brief** — one sentence is fine.

### Changelog format

Use these sections **in order**, omitting any that have no entries:

1. `## New Features` — New user-facing functionality
2. `## Improvements` — Enhancements, bug fixes, and polish to existing features
3. `## Under the Hood` — Non-user-facing changes (infra, refactors, performance, internal tooling). Keep descriptions brief and non-technical.

Each entry starts with a bold title and author link:

```
**Bold Title** — Description here. [author](PR-or-commit-url)
```

For small changes, a single sentence is fine. For significant user-facing features, write a full paragraph or more — include CLI usage examples, explain how features compose, and highlight important properties like security or performance.

Small example (patch-level changes):

```markdown
## Improvements
**Sidebar Toggle Fix** — Right sidebar visibility is now independent of its width, preventing layout glitches when toggling. [jake](https://github.com/jakemor/kanna/commit/187fba5)

## Under the Hood
**Modular ChatPage** — Split ChatPage into smaller components. [jake](https://github.com/jakemor/kanna/commit/def456)
```

Big example (v0.31.0 — a feature-rich release with detailed user-facing descriptions):

```markdown
## New Features

**Password Protection (`--password`)** — Lock your Kanna instance behind a password. When enabled, all routes — including the UI, API, health checks, and WebSocket connections — require authentication before anything loads. Passwords are verified using **timing-safe comparison** to prevent timing attacks, and sessions use **32-byte cryptographically random tokens** stored in `HttpOnly`, `SameSite=Strict`, `Secure` cookies. Sessions live in memory and reset when the process restarts — no tokens are ever written to disk. [jake](https://github.com/jakemor/kanna/commit/6e83973)

---

### Secure Remote Access — No VPN Required

Kanna now supports three levels of remote access, and they compose together for serious security:

**`--share`** creates an instant, temporary public URL via Cloudflare's quick tunnel service — great for quick demos or sharing a session with a teammate. The URL is randomly generated (e.g. `https://<random>.trycloudflare.com`) and a QR code is printed to the terminal for easy mobile access. The tunnel lives and dies with the Kanna process.

**`--cloudflared <token>`** connects a **pre-configured, named Cloudflare tunnel** using a token from your Cloudflare dashboard. Unlike `--share`, this gives you a **stable, custom hostname** (e.g. `kanna.yourdomain.com`) that persists across restarts. Combined with **Cloudflare Access**, you can layer on SSO, device posture checks, geo-restrictions, and IP allowlists — all before traffic even reaches your machine.

**`--password <secret>`** adds application-level authentication on top of either tunnel mode. Even if someone discovers the URL, they must enter the correct password to access anything.

#### The Security Stack

When you run:
\`\`\`bash
kanna --cloudflared <token> --password <secret>
\`\`\`

You get **three layers of security** without a VPN or Tailscale:

1. **Cloudflare's network** — DDoS protection, bot mitigation, and TLS termination at the edge
2. **Cloudflare Access** (optional) — SSO, MFA, device trust, geo-fencing, and IP restrictions before traffic reaches your tunnel
3. **Kanna's password auth** — timing-safe password verification, cryptographic session tokens, `HttpOnly`/`SameSite=Strict`/`Secure` cookies, CSRF origin validation on WebSocket connections

This is a production-grade way to securely access a remote development machine from anywhere in the world — no VPN, no Tailscale, no port forwarding, no exposed SSH. Just a browser.
```

If there are no changes at all, use: `No changes this release.`

### Step 4: Create the GitHub release

```bash
gh release create "v<new-version>" \
  --title "v<new-version>" \
  --notes "<changelog content>"
```

The GitHub Release triggers `.github/workflows/publish.yml`, which builds and publishes to npm via Trusted Publishing.

Tell the user the new version number and link to the release when done.
