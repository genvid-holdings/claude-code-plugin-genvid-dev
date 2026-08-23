// Finds and resolves positional `path:line` pointers written in this repo's
// prose and code comments, so a pointer that has decayed against a moved
// target can be detected instead of silently misleading a reader.
//
// This module selects the citing corpus, parses pointers together with their
// enclosing delimiters, resolves each cited path to a real file, and extracts
// the CONTENT ANCHOR the citing prose writes after the pointer. Anchor
// VERIFICATION — does the anchor actually appear at the cited line? — is a
// separate, later stage that consumes `collectPointers`' output. Nothing here
// reads a target's content.
//
// `(repoRoot, opts = {}) => findings[]` (async, pure — no fs writes), matching
// the shape of hygiene.mjs's scanners: `{ kind, ok: false, severity, detail }`
// plus `file`/`line`, since every finding is anchored to a specific citation
// site.
//
// Degenerate input never manufactures findings: a missing citing root, an
// unreadable file, or a repo with no matching files all contribute nothing.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { listUnder } from './fs-walk.mjs';
import { iterateUnfencedLines } from './md-scan.mjs';

// ---- corpus ------------------------------------------------------------------

// CITING files — where a pointer may be WRITTEN.
//
// `.md` and `.mjs` under the repo-root `docs/` and `plugin/` trees. Two scoping
// decisions here are load-bearing:
//
//   - `plugin/CHANGELOG.md` is deliberately INCLUDED, unlike the corpus
//     principle-citations.mjs walks. Release-note prose cites agent bodies by
//     line, and several of those pointers occur nowhere else in the repo, so
//     excluding the changelog would leave them unchecked.
//   - `.json` is deliberately NOT a citing type. Pointer strings are stored in
//     JSON — a ratchet baseline, test fixtures — precisely so that recording a
//     pointer does not mint a new one, and so the baseline cannot scan itself.
export const CITING_ROOTS = ['docs', 'plugin'];
export const CITING_EXTENSIONS = ['.md', '.mjs'];

// Directories excluded from BOTH corpora. `audit-conventions-evals/` holds
// fixture consuming-repos whose files carry contract filenames (`CLAUDE.md`,
// `CONVENTIONS.md`, `docs/TOC.md`, …); counting them as resolution candidates
// would turn correct, unambiguous citations of the real files into ambiguity
// findings. `.git` and `node_modules` are excluded as walk cost, not policy.
export const SKIPPED_DIRS = ['.git', 'node_modules', 'audit-conventions-evals'];

const SKIPPED_DIR_SET = new Set(SKIPPED_DIRS);

function isSkipped(relPath) {
  const top = relPath.split('/')[0];
  return SKIPPED_DIR_SET.has(top);
}

async function safeReadFile(path) {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

// Every file in the repo (minus SKIPPED_DIRS) is a possible TARGET. A cited
// target may carry any extension — live citations name `.mjs`, `.json` and
// `.md` alike — so the candidate set is deliberately not filtered by type,
// unlike the citing corpus above.
export async function listTargetCandidates(repoRoot) {
  let entries;
  try {
    entries = await fs.readdir(repoRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const subs = entries
    .filter((e) => e.isDirectory() && !SKIPPED_DIR_SET.has(e.name))
    .map((e) => e.name);
  const nested = await listUnder(repoRoot, subs, () => true);
  const rootFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
  return [...new Set([...rootFiles, ...nested])].sort();
}

export async function listCitingFiles(repoRoot) {
  const files = await listUnder(repoRoot, CITING_ROOTS, (name) =>
    CITING_EXTENSIONS.some((ext) => name.endsWith(ext)),
  );
  return files.filter((f) => !isSkipped(f));
}

// ---- grammar -----------------------------------------------------------------

// A cited path: slash-separated segments of `[A-Za-z0-9_.-]`, whose final
// segment ends in a `.<ext>` suffix. Requiring the extension is what keeps
// ordinary prose (`step 3:12`, a clock time, an issue reference) from parsing
// as a pointer.
//
// A backslash is deliberately absent from the class. That is not cosmetic: the
// `.mjs` half of the citing corpus includes test files full of escaped regex
// literals, and admitting a backslash would parse those escapes as paths.
const PATH_SOURCE = '[A-Za-z0-9_./-]*[A-Za-z0-9_-]\\.[A-Za-z0-9]+';

// A line specification: a single line, a range, or a comma-compound of either
// (`313-314`, `29,159-163`) — all shapes observed live in this repo.
const LINESPEC_SOURCE = '[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*';

const PATH_POINTER_RE = new RegExp(`(${PATH_SOURCE}):(${LINESPEC_SOURCE})`, 'g');
const BARE_LINESPEC_RE = new RegExp(`^:(${LINESPEC_SOURCE})$`);

// Backtick-delimited inline code spans on ONE line, in source order.
//
// Note this module deliberately does NOT call md-scan.mjs's `maskInlineCode`,
// which is the right primitive for the link and token scanners. A pointer
// normally lives INSIDE an inline-code span, so masking would erase the very
// text being parsed. Instead the span is parsed alongside the pointer, and its
// closing delimiter is reported — see `delimiterEnd` below.
function findCodeSpans(line) {
  const spans = [];
  const re = /(`+)([^]*?)\1/g;
  let match;
  while ((match = re.exec(line))) {
    const fence = match[1].length;
    spans.push({
      start: match.index,
      contentStart: match.index + fence,
      contentEnd: match.index + fence + match[2].length,
      end: match.index + match[0].length,
      content: match[2],
    });
  }
  return spans;
}

function enclosingSpan(spans, start, end) {
  return spans.find((s) => s.contentStart <= start && end <= s.contentEnd) || null;
}

export function parseLineSpec(spec) {
  return spec.split(',').map((part) => {
    const [from, to] = part.split('-');
    const start = Number(from);
    return { start, end: to === undefined ? start : Number(to) };
  });
}

// Parses every pointer on a single raw line, in source order.
//
// Each returned pointer records where its ENCLOSING DELIMITER ends, not merely
// where its own text ends. That distinction is the whole point of parsing the
// delimiter alongside the pointer: anchor extraction below looks for a content
// anchor AFTER the pointer, and a grammar that stopped at the pointer's last
// digit would read the pointer's own closing backtick as an anchor's opening
// delimiter — inferring connective prose as if it were quoted target text.
//
// Returns `[{ raw, citedPath, lineSpec, ranges, start, end, delimiterStart,
// delimiterEnd, enclosed, isContinuation }]`, with all offsets as indices into
// `line`. `citedPath` is null for a bare continuation.
export function parsePointersInLine(line) {
  const spans = findCodeSpans(line);
  const pointers = [];

  PATH_POINTER_RE.lastIndex = 0;
  let match;
  while ((match = PATH_POINTER_RE.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    const span = enclosingSpan(spans, start, end);
    pointers.push({
      raw: match[0],
      citedPath: match[1],
      lineSpec: match[2],
      ranges: parseLineSpec(match[2]),
      start,
      end,
      delimiterStart: span ? span.start : start,
      delimiterEnd: span ? span.end : end,
      enclosed: span != null,
      isContinuation: false,
    });
  }

  // A bare continuation — a colon and a line spec, no path — is only
  // recognized when it FILLS an inline-code span. Outside a code span such a
  // fragment is indistinguishable from ordinary punctuation, and every
  // continuation observed live in this repo is written inside backticks.
  //
  // (This comment names no literal example on purpose: `.mjs` is itself a
  // citing file type, so a worked example here would mint a real pointer.)
  for (const span of spans) {
    const bare = BARE_LINESPEC_RE.exec(span.content);
    if (!bare) continue;
    pointers.push({
      raw: span.content,
      citedPath: null,
      lineSpec: bare[1],
      ranges: parseLineSpec(bare[1]),
      start: span.contentStart,
      end: span.contentEnd,
      delimiterStart: span.start,
      delimiterEnd: span.end,
      enclosed: true,
      isContinuation: true,
    });
  }

  pointers.sort((a, b) => a.start - b.start);
  return pointers;
}

// ---- resolution --------------------------------------------------------------

// A candidate matches the cited path iff it EQUALS it or ends with `/` plus it.
//
// Never a bare suffix match. That distinction is load-bearing rather than
// pedantic: a bare suffix test conflates a file with any longer basename that
// happens to end in the same characters — a hyphen-prefixed sibling in the same
// directory is the exact shape this repo carries — and the `/` boundary rules
// that out by construction.
export function matchCandidates(candidates, citedPath) {
  const suffix = `/${citedPath}`;
  return candidates.filter((f) => f === citedPath || f.endsWith(suffix));
}

// ---- anchors -----------------------------------------------------------------

// A CONTENT ANCHOR is the fragment of the TARGET that the citing prose writes
// immediately after the pointer. It is what makes a positional citation
// checkable at all: the line number says where to look, and the anchor says
// what should be found there. A pointer carrying no anchor decays silently,
// because a stale line number still resolves to a real — merely unrelated —
// line.
//
// Exactly three forms are recognized, and the list is closed on purpose:
//
//   1. a double-quoted span — straight "…" or curly “…”;
//   2. a backticked identifier — `someIdentifier`;
//   3. a colon-introduced quoted span — : "…".
//
// Between the pointer's closing delimiter and the anchor's opening one, only a
// CONNECTOR WINDOW may intervene: an optional possessive ('s or ’s), a small
// amount of whitespace, and at most one connector character. Anything else —
// or nothing at all — means the pointer carries no anchor.
//
// The discriminator is what FOLLOWS the connector, never the connector itself.
// A possessive followed by a backticked identifier is an anchor; the same
// possessive followed by ordinary prose is not, and both shapes occur live in
// this repo within a few files of each other.
//
// Extraction starts at the pointer's `delimiterEnd` rather than searching the
// pointer's neighbourhood. That anchoring is the whole reason the grammar
// tracks delimiters: a proximity search was measured during design and
// produced roughly 40 "anchors" that were only connective prose (`" and "`,
// `"); a "`), while false-passing two genuinely stale pointers.
export const ANCHOR_CONNECTORS = ['(', ',', ';', ':', '—', '–'];

// The elision marker. An anchor containing it quotes the target with a gap, so
// verification (a later stage) must match it as ORDERED CONTAINMENT of the
// surrounding fragments and never as a literal substring. This stage only
// records that the elision is present and splits the fragments out.
export const ELISION = '…';

// An anchor may span ONE line break. Prose wraps wherever the fill happens to
// put it, and the corpus carries anchors broken mid-phrase whose continuation
// line arrives INDENTED — which is also why anchor text is stored with runs of
// whitespace squeezed rather than with newlines merely swapped for spaces. A
// swap alone leaves the continuation's indentation in the text and a
// single-space comparison then fails against a byte-correct target.
export const ANCHOR_LOOKAHEAD_LINES = 1;

// A small amount of whitespace, optionally crossing a single line break.
const WS = '[ \\t\\r]*(?:\\n[ \\t\\r]*)?';

// The connector window and the three anchor forms, anchored at offset 0 of the
// text following `delimiterEnd`.
const ANCHOR_RE = new RegExp(
  '^' +
    "(['’]s)?" + // (1) possessive
    WS +
    // (2) at most one connector character. The class is built from
    // ANCHOR_CONNECTORS so the exported list cannot drift from the grammar;
    // none of its members needs escaping inside a character class (the dashes
    // are the em/en dash, not ASCII hyphen).
    `([${ANCHOR_CONNECTORS.join('')}])?` +
    WS +
    '(?:' +
    '"([^"]+)"' + // (3) straight-quoted span
    '|“([^”]+)”' + // (4) curly-quoted span
    '|`([^`\\n]+)`' + // (5) backticked identifier
    ')',
);

// A backticked anchor must be IDENTIFIER-shaped: no whitespace, no slash, no
// colon. Without this the backticked span sitting after a comma in a run of
// sibling citations would be read as an anchor for the pointer before it —
// exactly the artifact class the delimiter anchoring exists to exclude.
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;

// Squeezes RUNS of whitespace to a single space. Squeezing rather than
// replacing is load-bearing — see ANCHOR_LOOKAHEAD_LINES above.
export function normalizeAnchorText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// Extracts the anchor from `tail` — the text that follows a pointer's closing
// delimiter, which may include the following source line joined with a '\n'.
//
// Returns null when no anchor is present, or `{ form, quoteStyle, connector,
// possessive, text, raw, fragments, hasElision, wrapped, start, end }` where
// `start`/`end` are offsets into `tail` bounding the anchor INCLUDING its
// delimiters, and `text` is the normalized inner content.
//
// Nothing here reads the cited target: verifying that `text` actually appears
// at the cited line is a separate, later stage.
export function extractAnchor(tail) {
  const match = ANCHOR_RE.exec(tail);
  if (!match) return null;

  const [, possessive, connector, straight, curly, backticked] = match;

  let form;
  let quoteStyle;
  let inner;
  if (backticked !== undefined) {
    if (!IDENTIFIER_RE.test(backticked)) return null;
    form = 'backticked';
    quoteStyle = null;
    inner = backticked;
  } else {
    inner = straight !== undefined ? straight : curly;
    quoteStyle = straight !== undefined ? 'straight' : 'curly';
    // Form (3) is form (1) reached through a colon connector; naming it
    // separately keeps the three declared forms distinguishable downstream.
    form = connector === ':' ? 'colon-quoted' : 'quoted';
  }

  // Every form uses a single-character delimiter on each side, so the anchor
  // spans exactly `inner.length + 2` characters ending where the match ends.
  const end = match[0].length;
  const start = end - (inner.length + 2);
  const raw = tail.slice(start, end);

  const text = normalizeAnchorText(inner);
  const fragments = text
    .split(ELISION)
    .map(normalizeAnchorText)
    .filter((fragment) => fragment !== '');
  // An anchor that normalizes away to nothing (whitespace only, or a bare
  // elision) carries no claim about the target and is not an anchor.
  if (fragments.length === 0) return null;

  return {
    form,
    quoteStyle,
    connector: connector === undefined ? null : connector,
    possessive: possessive !== undefined,
    text,
    raw,
    fragments,
    hasElision: text.includes(ELISION),
    wrapped: raw.includes('\n'),
    start,
    end,
  };
}

// Builds the search text for one pointer: the remainder of its own line after
// `delimiterEnd`, plus up to ANCHOR_LOOKAHEAD_LINES following lines.
//
// A following line is only joined when it is CONTIGUOUS (no gap in line
// numbers, which is how `iterateUnfencedLines` surfaces an intervening fenced
// block) and non-blank, since a blank line ends the paragraph.
//
// Returned as segments rather than a bare string so an offset into the joined
// text can be mapped back to a real line and column for the next stage.
function buildAnchorTail(lines, index, delimiterEnd) {
  const segments = [
    {
      lineNumber: lines[index].lineNumber,
      columnOffset: delimiterEnd,
      text: lines[index].text.slice(delimiterEnd),
    },
  ];
  for (let step = 1; step <= ANCHOR_LOOKAHEAD_LINES; step++) {
    const next = lines[index + step];
    if (!next) break;
    if (next.lineNumber !== lines[index + step - 1].lineNumber + 1) break;
    if (next.text.trim() === '') break;
    segments.push({ lineNumber: next.lineNumber, columnOffset: 0, text: next.text });
  }
  return segments;
}

function locateOffset(segments, offset) {
  let cursor = 0;
  for (const segment of segments) {
    if (offset <= cursor + segment.text.length) {
      return { line: segment.lineNumber, column: segment.columnOffset + (offset - cursor) };
    }
    cursor += segment.text.length + 1; // the joining newline
  }
  const last = segments[segments.length - 1];
  return { line: last.lineNumber, column: last.columnOffset + last.text.length };
}

// Attaches `anchor` to a parsed pointer, resolved to real line/column
// coordinates. Returns null when the pointer carries no anchor.
function anchorForPointer(lines, index, delimiterEnd) {
  const segments = buildAnchorTail(lines, index, delimiterEnd);
  const anchor = extractAnchor(segments.map((s) => s.text).join('\n'));
  if (!anchor) return null;
  const from = locateOffset(segments, anchor.start);
  const to = locateOffset(segments, anchor.end);
  return { ...anchor, line: from.line, column: from.column, endLine: to.line, endColumn: to.column };
}

// ---- collectPointers ---------------------------------------------------------

// Walks the citing corpus and returns every pointer found, each resolved
// against the repo's files, plus the resolution findings.
//
// Paragraph attachment: a bare continuation inherits the cited path of the most
// recent path-bearing pointer earlier in the SAME paragraph. A paragraph ends
// at a blank line, at end of file, or wherever a fenced block interrupts the
// stream of scanned lines (which `iterateUnfencedLines` surfaces as a gap in
// line numbers). A continuation with no such predecessor is an orphan.
//
// A continuation inherits its predecessor's resolution outcome and never
// reports an unresolved/ambiguous finding of its own — the path is written once
// and would otherwise be reported once per continuation that trails it.
//
// Anchors: every pointer gets `anchor` set to its extracted anchor or to null,
// and a resolved pointer with no anchor reports `pointer-anchor-missing`. A
// continuation is checked like any other pointer — it makes its own positional
// claim about a line, so it needs its own anchor. A pointer that did NOT
// resolve is exempt: it already reports a finding at that site, and an anchor
// cannot be held against a target that could not be identified.
export async function collectPointers(repoRoot, opts = {}) {
  const candidates = await listTargetCandidates(repoRoot);
  const citingFiles = await listCitingFiles(repoRoot);

  const pointers = [];
  const findings = [];

  for (const relPath of citingFiles) {
    const content = await safeReadFile(join(repoRoot, relPath));
    if (content == null) continue;

    // Materialized rather than streamed: anchor extraction needs to look at
    // the FOLLOWING line, because an anchor may wrap across a line break.
    const lines = [...iterateUnfencedLines(content)];

    let previousLineNumber = 0;
    let paragraph = 0;
    let lastResolved = null;

    const noteMissingAnchor = (pointer) => {
      if (pointer.anchor != null || pointer.resolution !== 'resolved') return;
      findings.push({
        kind: 'pointer-anchor-missing',
        ok: false,
        severity: 'error',
        detail:
          `${pointer.file}:${pointer.line} cites '${pointer.raw}' with no content anchor — ` +
          'follow the pointer with a quoted span, a backticked identifier, or a ' +
          'colon-introduced quotation naming what the cited line should contain, so the ' +
          'citation can be checked instead of silently decaying',
        file: pointer.file,
        line: pointer.line,
      });
    };

    for (let index = 0; index < lines.length; index++) {
      const { lineNumber, text } = lines[index];
      if (lineNumber !== previousLineNumber + 1 || text.trim() === '') {
        paragraph += 1;
        lastResolved = null;
      }
      previousLineNumber = lineNumber;

      for (const parsed of parsePointersInLine(text)) {
        const pointer = {
          ...parsed,
          file: relPath,
          line: lineNumber,
          lineText: text,
          paragraph,
          target: null,
          resolution: 'resolved',
          anchor: anchorForPointer(lines, index, parsed.delimiterEnd),
        };

        if (parsed.isContinuation) {
          if (lastResolved == null) {
            pointer.resolution = 'orphan';
            findings.push({
              kind: 'pointer-orphan-continuation',
              ok: false,
              severity: 'error',
              detail:
                `${relPath}:${lineNumber} writes continuation pointer '${parsed.raw}' with no ` +
                'path-bearing pointer earlier in the same paragraph to attach it to',
              file: relPath,
              line: lineNumber,
            });
          } else {
            pointer.citedPath = lastResolved.citedPath;
            pointer.target = lastResolved.target;
            pointer.resolution = lastResolved.resolution;
          }
          noteMissingAnchor(pointer);
          pointers.push(pointer);
          continue;
        }

        const matches = matchCandidates(candidates, parsed.citedPath);
        if (matches.length === 1) {
          pointer.target = matches[0];
        } else if (matches.length === 0) {
          pointer.resolution = 'unresolved';
          findings.push({
            kind: 'pointer-unresolved',
            ok: false,
            severity: 'error',
            detail:
              `${relPath}:${lineNumber} cites '${parsed.raw}' but no file in the repo ` +
              `matches the path '${parsed.citedPath}'`,
            file: relPath,
            line: lineNumber,
          });
        } else {
          pointer.resolution = 'ambiguous';
          findings.push({
            kind: 'pointer-ambiguous',
            ok: false,
            severity: 'error',
            detail:
              `${relPath}:${lineNumber} cites '${parsed.raw}' but the path '${parsed.citedPath}' ` +
              `matches ${matches.length} files (${summarizeMatches(matches)}) — write enough ` +
              'leading path segments to name exactly one',
            file: relPath,
            line: lineNumber,
          });
        }

        noteMissingAnchor(pointer);
        lastResolved = pointer;
        pointers.push(pointer);
      }
    }
  }

  return { pointers, findings, candidates, citingFiles };
}

function summarizeMatches(matches, limit = 3) {
  if (matches.length <= limit) return matches.join(', ');
  return `${matches.slice(0, limit).join(', ')}, and ${matches.length - limit} more`;
}

// ---- scanPointerAnchors ------------------------------------------------------

// `opts` is accepted for signature parity with hygiene.mjs's scanners and is
// forwarded to `collectPointers`; this stage has no configurable behaviour of
// its own, since the corpus decisions above are contract, not preference.
export async function scanPointerAnchors(repoRoot, opts = {}) {
  const { findings } = await collectPointers(repoRoot, opts);
  return findings;
}
