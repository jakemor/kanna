export const HUNK_START = "--- HUNK ---";
export const HUNK_END = "--- END HUNK ---";
export const HUNK_NOTE_START = "--- HUNK NOTE ---";
export const HUNK_NOTE_END = "--- END HUNK NOTE ---";
export const CHANGE_NOTE_START = "--- CHANGE NOTE ---";
export const CHANGE_NOTE_END = "--- END CHANGE NOTE ---";
export const SUMMARY_START = "--- SUMMARY ---";
export const SUMMARY_END = "--- END SUMMARY ---";

export function parseAgentResponse(text = "") {
  const source = String(text);
  const noteHunks = parseNoteBlocks(source, CHANGE_NOTE_START, CHANGE_NOTE_END);
  const legacyNoteHunks = noteHunks.hunks.length || noteHunks.partial
    ? noteHunks
    : parseNoteBlocks(source, HUNK_NOTE_START, HUNK_NOTE_END);
  const compactNotes = noteHunks.hunks.length || noteHunks.partial ? noteHunks : legacyNoteHunks;
  if (compactNotes.hunks.length || compactNotes.partial) {
    const summary = extractBetween(source, SUMMARY_START, SUMMARY_END);
    const partial = compactNotes.partial || extractPartialSummary(source);

    return {
      hunks: compactNotes.hunks,
      summary,
      partial,
      isComplete: summary.length > 0 && partial.length === 0,
      raw: source,
    };
  }

  const hunks = [];
  let cursor = 0;
  let partial = "";

  while (cursor < source.length) {
    const start = source.indexOf(HUNK_START, cursor);
    if (start === -1) {
      break;
    }

    const blockStart = start + HUNK_START.length;
    const end = source.indexOf(HUNK_END, blockStart);
    if (end === -1) {
      partial = source.slice(start).trim();
      break;
    }

    const block = source.slice(blockStart, end);
    hunks.push(parseHunkBlock(block, hunks.length));
    cursor = end + HUNK_END.length;
  }

  const summary = extractBetween(source, SUMMARY_START, SUMMARY_END);
  partial = partial || extractPartialSummary(source);

  return {
    hunks,
    summary,
    partial,
    isComplete: summary.length > 0 && partial.length === 0,
    raw: source,
  };
}

function parseNoteBlocks(source, startMarker, endMarker) {
  const hunks = [];
  let cursor = 0;
  let partial = "";

  while (cursor < source.length) {
    const start = source.indexOf(startMarker, cursor);
    if (start === -1) {
      break;
    }

    const blockStart = start + startMarker.length;
    const end = source.indexOf(endMarker, blockStart);
    if (end === -1) {
      partial = source.slice(start).trim();
      break;
    }

    const block = source.slice(blockStart, end);
    hunks.push(parseHunkNoteBlock(block, hunks.length));
    cursor = end + endMarker.length;
  }

  return { hunks, partial };
}

function parseHunkNoteBlock(block, index) {
  const trimmed = trimBlankLines(block);
  const id = extractLineValue(trimmed, "ID") || `H${String(index + 1).padStart(3, "0")}`;
  const description = extractLineValue(trimmed, "Description");

  return {
    id,
    diff: "",
    description,
  };
}

function parseHunkBlock(block, index) {
  const trimmed = trimBlankLines(block);
  const descriptionMatch = trimmed.match(/\n\s*Description:\s*([\s\S]*)$/);
  const description = descriptionMatch ? descriptionMatch[1].trim() : "";
  const diff = descriptionMatch
    ? trimBlankLines(trimmed.slice(0, descriptionMatch.index))
    : trimmed;

  return {
    id: `hunk-${index + 1}`,
    diff,
    description,
  };
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    return "";
  }

  const contentStart = start + startMarker.length;
  const end = source.indexOf(endMarker, contentStart);
  if (end === -1) {
    return "";
  }

  return source.slice(contentStart, end).trim();
}

function extractLineValue(source, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)\\s*${escaped}:\\s*([^\\n]+)`));
  return match ? match[1].trim() : "";
}

function extractPartialSummary(source) {
  const summaryStart = source.indexOf(SUMMARY_START);
  if (summaryStart !== -1 && source.indexOf(SUMMARY_END, summaryStart) === -1) {
    return source.slice(summaryStart).trim();
  }
  return "";
}

function trimBlankLines(value) {
  return String(value).replace(/^\s*\n/, "").replace(/\n\s*$/, "");
}
