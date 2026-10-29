// Bounded text helpers. Everything the ledger stores or prints goes through
// these: a catchup ledger is a summary, never a transcript.

/** Collapse whitespace (including newlines) into single spaces. */
export function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** One line, capped at `max` characters, with an ellipsis when cut. */
export function clip(value, max = 240) {
  const line = oneLine(value);
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The first non-empty paragraph of a longer body, collapsed and clipped. */
export function firstParagraph(value, max = 240) {
  for (const block of String(value ?? "").split(/\n\s*\n/)) {
    const line = oneLine(block);
    if (line !== "") return clip(line, max);
  }
  return "";
}
