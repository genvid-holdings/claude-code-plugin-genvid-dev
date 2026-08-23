// Shared Markdown line-scanning primitives for audit-conventions' content
// scanners.
//
// Every scanner that greps Markdown *content* (broken links, retired tokens,
// pointer anchors) needs the same two things before it can look at a line:
// skip fenced code blocks, and blank out inline code spans. Both rules exist
// so a doc that *shows* Markdown as an example doesn't get scanned as if the
// example were real. This module is the single home for that logic.
//
// Pure and fs-free: these are string functions, not scanners. They take
// content, not a path.

// Yields every line of `content` that sits OUTSIDE a fenced code block, as
// `{ lineNumber, text }` with a 1-based lineNumber and the RAW (untrimmed)
// line text.
//
// Fence semantics — deliberately identical to the inFence tracking these
// scanners have always used, so migrating a scanner onto this helper is a
// no-op for behaviour:
//
//   - A line whose TRIMMED form starts with ``` or ~~~ toggles the fence
//     state and is itself never yielded — a fence delimiter line is never
//     content to scan.
//   - Lines between an opening and a closing delimiter are never yielded.
//   - The toggle is a flip, not a matched-delimiter parser: it does not track
//     which delimiter opened the fence, nor fence length. A ~~~ inside a ```
//     fence therefore CLOSES it. That matches the historical behaviour and is
//     accepted as-is; nested fences are rare in these docs and the failure
//     direction is scanning slightly more than intended, not less.
//   - An unterminated fence at EOF simply suppresses the remaining lines.
//     There is no repair pass — the file is what it is.
//
// `content` is expected to be a string (callers read it with a null-guarded
// file read first). Note '' yields one empty line, since ''.split('\n') is
// [''] — again matching the historical loop rather than special-casing it.
export function* iterateUnfencedLines(content) {
  const lines = content.split('\n');
  let inFence = false;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue; // fence delimiter line itself is never scannable content
    }
    if (inFence) continue;

    yield { lineNumber: idx + 1, text: line };
  }
}

// Blanks out backtick-delimited inline code spans on a single line so a
// scanner's pattern doesn't match markup shown as an example inside them.
// Replaces each span with an equal-length run of spaces, so column offsets
// into the returned line still line up with the original.
//
// Operates per-line (deliberately not `[\s\S]` across the whole file) so an
// unmatched backtick run (no closing run on the same line) leaves the line
// unchanged — normal content elsewhere on that line still scans.
export function maskInlineCode(line) {
  return line.replace(/(`+)[\s\S]*?\1/g, (span) => ' '.repeat(span.length));
}
