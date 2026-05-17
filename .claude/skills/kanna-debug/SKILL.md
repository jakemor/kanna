---
name: kanna-debug
description: Pull rich context from a Kanna chat session transcript when debugging or troubleshooting a Kanna issue. Use whenever the user pastes a Kanna session/chat id (UUID like `ab06e5ab-6f15-42ab-b630-fbb7abfe7640`), says things like "debug this session", "what happened in chat X", "the chat got stuck", "this session crashed", "investigate session Y", "explain why the tool failed", or otherwise references a Kanna chat that needs analysis. Also use when the user is debugging Kanna server behavior (event-store, agent loop, tool callbacks, PTY driver) and mentions a session id — the transcript shows exactly which tool calls fired, what the model said, and where errors surfaced. Do not use for stack traces or logs that are not Kanna chat transcripts.
user-invocable: false
---

# Kanna debug — read the chat transcript

Kanna persists every chat to a per-chat JSONL transcript on disk. When the user gives you a session/chat id and asks why something happened, that file is the source of truth: it records every user message, every assistant response, every tool call and its result, in order. Read it before you guess.

## Where transcripts live

Kanna stores transcripts under its data dir:

- Production runtime: `~/.kanna/data/transcripts/<chatId>.jsonl`
- Dev runtime (`KANNA_BRANDING_OVERRIDE=dev` or running `bun dev`): `~/.kanna-dev/data/transcripts/<chatId>.jsonl`

The `<chatId>` is the UUID the user pastes. Try the prod path first; fall back to dev. If both miss, list the directory and grep — chat ids can collide with old / archived sessions and the user may have copied a partial id.

```bash
# Resolve path, prefer prod
TRANSCRIPT="$HOME/.kanna/data/transcripts/<chatId>.jsonl"
[ -f "$TRANSCRIPT" ] || TRANSCRIPT="$HOME/.kanna-dev/data/transcripts/<chatId>.jsonl"
[ -f "$TRANSCRIPT" ] || ls ~/.kanna/data/transcripts/ ~/.kanna-dev/data/transcripts/ 2>/dev/null | grep <partial-id>
```

## Step 1 — summarize first, then drill in

Transcripts get big fast (hundreds of tool calls = tens of MB). Reading the raw file blindly burns context. Run the bundled summarizer first; it produces a compact timeline of every entry with tool name, status, and a short preview. Only after you know which entry is interesting should you `jq` the original line for full detail.

```bash
python3 scripts/summarize_transcript.py "$TRANSCRIPT"
```

Flags (all optional):

- `--kinds tool_call,tool_result,user_prompt` — filter to specific entry kinds
- `--tool Bash,Edit` — filter tool calls to specific tools
- `--errors-only` — show only failed tool results
- `--last N` — show only the final N entries (useful for "what crashed at the end")
- `--around <_id>` — show 5 entries before/after a specific entry id

## Step 2 — pull the full payload for entries that matter

The summarizer prints each entry's `_id`. Use `jq` to retrieve the full JSON, which carries the raw SDK payload in `debugRaw`:

```bash
jq -c 'select(._id == "<entry-id>")' "$TRANSCRIPT"
```

For a tool call, the interesting fields are `tool.toolName`, `tool.input`, and the matching `tool_result.content` / `isError`. For an assistant message, `text` is what the model said. The `debugRaw` field is the unparsed JSONL frame the SDK or PTY driver wrote — useful when you suspect the parser dropped data.

## Entry shapes

Each line is one JSON object. Common fields: `_id` (uuid), `createdAt` (epoch ms), `kind`, plus kind-specific fields.

| kind            | key fields                                                             | meaning                                  |
|-----------------|------------------------------------------------------------------------|------------------------------------------|
| `system_init`   | `provider`, `model`, `tools[]`, `mcpServers[]`, `debugRaw`             | session start — confirms model + tools   |
| `account_info`  | `accountInfo.tokenSource`, `accountInfo.apiProvider`                   | which OAuth token / billing path         |
| `user_prompt`   | `content`, `attachments[]`                                             | what the human typed                     |
| `assistant_text`| `text`                                                                 | model's visible reply                    |
| `tool_call`     | `tool.toolName`, `tool.toolId`, `tool.input`                           | model invoked a tool                     |
| `tool_result`   | `toolId`, `content`, `isError`                                         | tool returned (`isError: true` = failed) |

Pair `tool_call.tool.toolId` with `tool_result.toolId` to match a call to its result.

## What to look for, by symptom

- **"Session got stuck / hung"** → check the last `tool_call` without a matching `tool_result`. The agent is waiting on something that never returned. For `AskUserQuestion` / `ExitPlanMode` under `KANNA_MCP_TOOL_CALLBACKS=1`, cross-check `tool-requests.jsonl` for a pending durable approval.
- **"Tool failed"** → `--errors-only` lists every `isError: true`. The `content` field has the error string the SDK surfaced.
- **"Model did the wrong thing"** → read the `user_prompt` then the next 1-2 `assistant_text` and `tool_call` entries. Often the prompt was ambiguous or an attachment was missing.
- **"Permission denied / approval loop"** → search for `tool` names matching `mcp__kanna__*` and look at the result content; the durable approval protocol writes a deny reason there.
- **"Billing went to API not subscription"** → check the `system_init.debugRaw.apiKeySource` and the `account_info.tokenSource`. PTY driver requires `apiKeySource: "none"` and a CLAUDE_CODE_OAUTH_TOKEN source.
- **"Wrong model / unexpected model switch"** → `system_init.model` shows the start model; the SDK writes a new `system_init` on model switch, so multiple `system_init` lines = mid-session switch.

## Step 3 — connect to the server-side event log if needed

The transcript is the model-facing view. Server-side events (chat lifecycle, tool-request decisions, push notifications) live in sibling files:

- `~/.kanna/data/turns.jsonl` — turn events per chat
- `~/.kanna/data/tool-requests.jsonl` — durable approval requests
- `~/.kanna/data/chats.jsonl` — chat create/rename/archive
- `~/.kanna/data/snapshot.json` — periodic full state

Filter any of these by `chatId`:

```bash
jq -c 'select(.chatId == "<chatId>")' ~/.kanna/data/turns.jsonl
```

Cross-referencing a tool_call's `createdAt` with the matching `tool-requests.jsonl` entry tells you whether the user approved, denied, or the request timed out.

## Why this matters

Without the transcript you are guessing. With it you can say exactly: "at 11:03:42 the model called Bash with `rm -rf …`, the tool callback returned deny:timeout 600s later, then assistant_text said 'I cannot proceed' and the chat went idle." That precision is what makes Kanna bug reports actionable instead of "it didn't work".
