export function computeDiffStats(diff = "") {
  const lines = String(diff).split(/\r?\n/);
  const files = new Set();
  let hunks = 0;
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      files.add(line);
      continue;
    }

    if (line.startsWith("@@")) {
      hunks += 1;
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }

  return {
    files: files.size,
    hunks,
    additions,
    deletions,
    lines: lines.filter(Boolean).length,
  };
}
