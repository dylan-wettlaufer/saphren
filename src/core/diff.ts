import { diffLines } from "diff";

/** Classification of a single line in a computed line diff. */
export type DiffLineType = "context" | "added" | "removed";

/** A single line in a unified-style line diff produced by `computeLineDiff`. */
export interface DiffLine {
  readonly type: DiffLineType;
  /** Line text without its trailing line ending. */
  readonly value: string;
}

function splitChangeLines(chunk: string): string[] {
  if (chunk.length === 0) {
    return [];
  }
  // Strip a single trailing line terminator emitted by `diffLines` so we don't
  // append a phantom empty line while still preserving intentional blank lines.
  const withoutTrailingNewline = chunk.endsWith("\r\n")
    ? chunk.slice(0, -2)
    : chunk.endsWith("\n")
      ? chunk.slice(0, -1)
      : chunk;
  return withoutTrailingNewline.split(/\r?\n/);
}

/**
 * Computes a line-by-line diff between `oldText` and `newText` using `diffLines`.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const changes = diffLines(oldText, newText);
  const result: DiffLine[] = [];

  for (const change of changes) {
    const type: DiffLineType = change.added ? "added" : change.removed ? "removed" : "context";
    for (const line of splitChangeLines(change.value)) {
      result.push({ type, value: line });
    }
  }

  return result;
}
