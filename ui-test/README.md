# Codex Git Diff Analyzer UI

Local UI for analyzing git diffs through `codex app-server`.

## Run

```sh
cd ui-test
npm start
```

Open the printed localhost URL.

The bridge uses the `codex` binary on `PATH` by default. To point at a specific binary:

```sh
CODEX_BIN=/absolute/path/to/codex npm start
```

## Test

```sh
cd ui-test
npm test
```

The app is dependency-free: Node serves the UI, starts `codex app-server`, and streams updates to the browser with Server-Sent Events. The bridge splits the diff into local change-block IDs before prompting Codex, so Codex streams only IDs, descriptions, and the summary instead of repeating the full diff back.
