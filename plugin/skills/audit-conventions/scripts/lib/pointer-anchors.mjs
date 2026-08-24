// Finds and resolves positional `path:line` pointers written in this repo's
// prose and code comments, so a pointer that has decayed against a moved
// target can be detected instead of silently misleading a reader.
//
// This module selects the citing corpus, parses pointers together with their
// enclosing delimiters, resolves each cited path to a real file, extracts the
// CONTENT ANCHOR the citing prose writes after the pointer, and VERIFIES that
// anchor against the cited target. Verification has exactly three outcomes:
// the anchor sits inside the cited line range (silent), it sits elsewhere in
// the target (`pointer-anchor-drift`, naming the line it is really on), or it
// is absent from the target entirely (`pointer-anchor-broken`).
//
// `collectPointers` stays purely structural — it reads CITING files only —
// and `verifyAnchors` is the one stage that reads a TARGET's content. The two
// compose in `scanPointerAnchors`, which then applies the RATCHET: a repo-root
// baseline of accepted debt, so the checker can run at `error` severity against
// a corpus that does not conform yet. See the baseline section at the foot of
// this file.
//
// `(repoRoot, opts = {}) => findings[]` (async, pure — no fs writes), matching
// the shape of hygiene.mjs's scanners: `{ kind, ok: false, severity, detail }`
// plus `file`/`line`, since every finding is anchored to a specific citation
// site. Findings additionally carry `pointer`/`occurrence`/`digest`, which is
// what the baseline keys and compares against — see `baselineKey`.
//
// Degenerate input never manufactures findings: a missing citing root, an
// unreadable file, or a repo with no matching files all contribute nothing.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { listUnder } from './fs-walk.mjs';
import { gitTrackedFiles } from './git-info.mjs';
import { iterateUnfencedLines } from './md-scan.mjs';

// ---- corpus ------------------------------------------------------------------

// CITING files — where a pointer may be WRITTEN.
//
// `.md` and `.mjs` under the repo-root `docs/` and `plugin/` trees, plus the
// tracked files of the repo root ITSELF (see `listRootCitingFiles`). Two
// scoping decisions here are load-bearing:
//
//   - `plugin/CHANGELOG.md` is deliberately INCLUDED, unlike the corpus
//     principle-citations.mjs walks. Release-note prose cites agent bodies by
//     line, and several of those pointers occur nowhere else in the repo, so
//     excluding the changelog would leave them unchecked.
//   - `.json` is deliberately NOT a citing type. Pointer strings are stored in
//     JSON — the ratchet baseline below, test fixtures — precisely so that
//     recording a pointer does not mint a new one, and so the baseline cannot
//     scan itself.
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

// The repo root's OWN citing files — `CLAUDE.md` and `README.md` in this repo.
//
// Excluding them was a real gap: `CLAUDE.md` is the densest single body of
// prose about the plugin's internals, and it cited a moved line.
//
// Scoped by `git ls-files` rather than by a directory listing, and TRACKING IS
// THE CONSTRAINT, not hygiene. The repo root is also where gitignored working
// artifacts land — a transient planning document is the live case, and the one
// present when this was written held eleven pointers — and admitting one would
// break the ratchet two ways at once. Its findings would have to be baselined,
// so the baseline would depend on a file no other developer has; and a working
// document written while repairing pointers cites the very strings the guard
// test forbids the baseline from ever accepting, so those findings could be
// neither fixed (the artifact is not the branch's to edit) nor accepted.
// Unresolvable by construction. Tracking is the line between the repo's own
// prose and a local scratch file.
//
// Only the root's own entries are listed, never a walk from it: the two citing
// TREES above are already walked whole, and re-deriving them here would just
// duplicate that.
//
// A null from `gitTrackedFiles` — not a git repo, or git unavailable —
// contributes nothing, the same graceful degradation hygiene.mjs applies to
// the same null in its own config-candidate set. The tree walk is unaffected,
// so a non-git checkout falls back to the previous corpus instead of failing.
async function listRootCitingFiles(repoRoot) {
  const tracked = gitTrackedFiles(repoRoot);
  if (tracked == null) return [];

  let entries;
  try {
    entries = await fs.readdir(repoRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => CITING_EXTENSIONS.some((ext) => name.endsWith(ext)))
    .filter((name) => tracked.has(name));
}

export async function listCitingFiles(repoRoot) {
  const nested = await listUnder(repoRoot, CITING_ROOTS, (name) =>
    CITING_EXTENSIONS.some((ext) => name.endsWith(ext)),
  );
  const root = await listRootCitingFiles(repoRoot);
  return [...new Set([...nested, ...root])].filter((f) => !isSkipped(f)).sort();
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
// amount of whitespace, at most one connector character, and an optional
// markdown emphasis marker immediately before the span. Anything else — or
// nothing at all — means the pointer carries no anchor.
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
// verification below matches it as ORDERED CONTAINMENT of the surrounding
// fragments and never as a literal substring. This stage only records that the
// elision is present and splits the fragments out.
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

// A markdown emphasis marker may wrap the anchor's own delimiters — the corpus
// writes one anchor as `(*"…"*)`, a quoted span italicized inside its
// connector parenthesis. The markers are consumed by the grammar rather than
// stored, so `text` stays the quoted content alone.
//
// This is deliberately narrow: exactly one optional marker, immediately before
// the span's OPENING delimiter. The wrapped shape was measured at ONE
// occurrence across docs/ and plugin/, which does not justify admitting
// emphasis at every position in the window.
//
// The CLOSING marker needs no rule at all — the match ends at the span's
// closing delimiter and simply leaves the rest of the tail unread, so a
// trailing `*` is outside the anchor either way. (An emphasis marker INSIDE
// the quotes is a third case: it stays in the stored text, and verification
// strips it from both sides before comparing.)
const EMPHASIS_SOURCE = '(?:\\*\\*|\\*|__|_)';

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
    `${EMPHASIS_SOURCE}?` + // opening emphasis marker, not captured
    '(?:' +
    '"([^"]+)"' + // (3) straight-quoted span
    '|“([^”]+)”' + // (4) curly-quoted span
    '|`([^`\\n]+)`' + // (5) backticked identifier
    ')',
);

// A backticked anchor must be IDENTIFIER-shaped: no whitespace, no slash, no
// colon. Those three exclusions are what does the work. Without them the
// backticked span sitting after a comma in a run of sibling citations would be
// read as an anchor for the pointer before it — exactly the artifact class the
// delimiter anchoring exists to exclude, and a sibling pointer is ruled out by
// its slash and its colon.
//
// A HYPHEN IS ADMITTED, and was never part of that defence. The corpus's most
// common backticked spans are kebab-case skill and agent names and hyphenated
// filenames; banning the hyphen rejected all of them as anchors while the
// anchor-missing finding told their authors to write exactly what they had
// already written. A hyphen cannot reintroduce the sibling-pointer artifact,
// because a pointer needs the colon this pattern still refuses.
const IDENTIFIER_RE = /^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)*(?:\(\))?$/;

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
// `start`/`end` are offsets into `tail` bounding the anchor INCLUDING its own
// delimiters but EXCLUDING any emphasis markers wrapping them, and `text` is
// the normalized inner content.
//
// Nothing here reads the cited target: verifying that `text` actually appears
// at the cited line is `verifyAnchor` below.
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
  // An opening emphasis marker sits before `start` and is therefore excluded
  // from the reported span by the same arithmetic.
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
//
// Occurrence index: every pointer records its ordinal among pointers with the
// IDENTICAL raw text in the same citing file, and every finding carries that
// ordinal plus the raw text. Together with the citing path they form the
// baseline key (see `baselineKey`) — deliberately NOT the citing line number,
// so an accepted pointer survives its own document being renumbered.
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
    const occurrences = new Map();

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
        pointer: pointer.raw,
        occurrence: pointer.occurrence,
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
        const occurrence = occurrences.get(parsed.raw) ?? 0;
        occurrences.set(parsed.raw, occurrence + 1);
        const pointer = {
          ...parsed,
          file: relPath,
          line: lineNumber,
          lineText: text,
          paragraph,
          occurrence,
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
              pointer: parsed.raw,
              occurrence,
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
            pointer: parsed.raw,
            occurrence,
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
            pointer: parsed.raw,
            occurrence,
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

// ---- verification ------------------------------------------------------------

// Reads the cited target and asks whether the anchor is really there. Three
// outcomes, and the middle one is what the whole design is for:
//
//   - inside the cited line range          → nothing;
//   - elsewhere in the target              → `pointer-anchor-drift`, NAMING the
//                                            line the anchor is really on, so
//                                            the repair is mechanical;
//   - nowhere in the target                → `pointer-anchor-broken`.
//
// A pointer with an anchor and NO line number is fully conforming as long as
// the anchor is present somewhere in the target. That is the renumber-proof
// shape the drift finding steers citations toward: with nothing positional to
// decay, an edit above the cited content cannot invalidate it.

// Markdown emphasis markers are noise for comparison: a target that bolds a
// phrase the citation quotes plain (or the reverse) still says the same thing,
// and this repo's prose emphasizes freely.
//
// Asterisk runs go unconditionally. An underscore goes only at a word
// BOUNDARY, so an INTRA-word underscore survives: `DEFAULT_EXCLUDE_PATHS` stays
// itself instead of collapsing into a letter run that would then also equal a
// different identifier spelled without the underscores. A boundary underscore
// on an identifier (a leading `__` on a dunder name) is stripped like any other
// emphasis opener — harmless, because both sides get exactly this treatment and
// the text a finding quotes back is the stored anchor text, never this form.
export function stripEmphasisMarkers(text) {
  return text
    .replace(/\*{1,3}/g, '')
    .replace(/(^|[^A-Za-z0-9_])_{1,2}(?=[^\s_])/g, '$1')
    .replace(/(?<=[^\s_])_{1,2}(?=[^A-Za-z0-9_]|$)/g, '');
}

// The comparison form, applied IDENTICALLY to both sides. Whitespace runs are
// squeezed (an anchor wraps mid-phrase in the citing prose, and the target's
// own line may be indented — neither may defeat a match), case is folded, and
// emphasis markers are stripped.
export function normalizeForMatch(text) {
  return stripEmphasisMarkers(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

// Flattens a target into one normalized string plus a sorted offset→line map.
//
// Flattening rather than comparing line by line is what lets an anchor match
// text the TARGET wraps across lines, which is the mirror of the wrap the
// citing side already tolerates. Each line is normalized on its own — so its
// leading indentation is gone before the join — and the lines are joined with
// a single space, so a phrase broken across two target lines reads as one
// space-separated phrase here. Blank lines contribute nothing.
export function buildTargetIndex(content) {
  const lines = content.split(/\r?\n/);
  let text = '';
  const marks = [];
  for (let index = 0; index < lines.length; index++) {
    const normalized = normalizeForMatch(lines[index]);
    if (normalized === '') continue;
    if (text !== '') text += ' ';
    marks.push({ offset: text.length, line: index + 1 });
    text += normalized;
  }
  return { text, marks };
}

function lineAtOffset(marks, offset) {
  if (marks.length === 0) return 0;
  let low = 0;
  let high = marks.length - 1;
  let line = marks[0].line;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (marks[mid].offset <= offset) {
      line = marks[mid].line;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return line;
}

// Every place the anchor's fragments occur in order, as `{ line, endLine }`.
//
// ORDERED CONTAINMENT, never a literal substring: an elided anchor quotes the
// target with a gap, and the elided text is by definition not reproduced in the
// citation. A single-fragment anchor is the degenerate case of the same rule.
export function findAnchorOccurrences(index, fragments) {
  const occurrences = [];
  if (fragments.length === 0) return occurrences;

  const [first, ...rest] = fragments;
  let from = 0;
  for (;;) {
    const start = index.text.indexOf(first, from);
    if (start === -1) break;

    let cursor = start + first.length;
    let complete = true;
    for (const fragment of rest) {
      const at = index.text.indexOf(fragment, cursor);
      if (at === -1) {
        complete = false;
        break;
      }
      cursor = at + fragment.length;
    }
    // A later occurrence of the first fragment starts its own search even
    // further along, so a tail that failed here cannot succeed there.
    if (!complete) break;

    occurrences.push({
      line: lineAtOffset(index.marks, start),
      endLine: lineAtOffset(index.marks, cursor - 1),
    });
    from = start + 1;
  }
  return occurrences;
}

// An occurrence satisfies the citation when the lines it SPANS intersect any
// cited range — a phrase that begins on the line before the cited one and runs
// through it is at the cited line, not drifted from it.
function occursWithin(occurrence, ranges) {
  return ranges.some((range) => occurrence.line <= range.end && occurrence.endLine >= range.start);
}

function distanceToRanges(occurrence, ranges) {
  return Math.min(
    ...ranges.map((range) =>
      occurrence.endLine < range.start
        ? range.start - occurrence.endLine
        : occurrence.line - range.end,
    ),
  );
}

// The NEAREST occurrence to the cited range, not the first in the file.
//
// Load-bearing on real data: this repo cites an identifier two lines above its
// definition, while the same name also appears in a section comment forty-odd
// lines earlier. A first-occurrence rule names that comment, turning a
// two-line repair into a forty-line one in the wrong direction — a "fix" that
// moves a nearly-right pointer badly wrong. Ties keep the earlier occurrence,
// since the scan is ordered and the comparison is strict.
function nearestOccurrence(occurrences, ranges) {
  let nearest = occurrences[0];
  let shortest = distanceToRanges(nearest, ranges);
  for (const occurrence of occurrences.slice(1)) {
    const distance = distanceToRanges(occurrence, ranges);
    if (distance < shortest) {
      nearest = occurrence;
      shortest = distance;
    }
  }
  return nearest;
}

// Verifies one pointer's anchor against its target's `content`. Returns a
// finding or null. Pure — the caller owns the read.
export function verifyAnchor(pointer, content) {
  const { anchor } = pointer;
  if (anchor == null) return null;

  const fragments = anchor.fragments.map(normalizeForMatch).filter((f) => f !== '');
  // An anchor that normalizes away entirely (emphasis markers and nothing
  // else) claims nothing about the target and is not evidence of decay.
  if (fragments.length === 0) return null;

  const occurrences = findAnchorOccurrences(buildTargetIndex(content), fragments);
  const site = `${pointer.file}:${pointer.line}`;
  const quoted = anchor.form === 'backticked' ? `\`${anchor.text}\`` : `"${anchor.text}"`;

  if (occurrences.length === 0) {
    return {
      kind: 'pointer-anchor-broken',
      ok: false,
      severity: 'error',
      detail:
        `${site} cites '${pointer.raw}' with anchor ${quoted}, which appears nowhere in ` +
        `${pointer.target} — the cited content was rewritten or removed, so re-read the ` +
        'target and rewrite the citation around what is there now',
      file: pointer.file,
      line: pointer.line,
      pointer: pointer.raw,
      occurrence: pointer.occurrence,
    };
  }

  const ranges = pointer.ranges ?? [];
  if (ranges.length === 0) return null; // anchored, unpositioned — nothing to drift
  if (occurrences.some((occurrence) => occursWithin(occurrence, ranges))) return null;

  const nearest = nearestOccurrence(occurrences, ranges);
  return {
    kind: 'pointer-anchor-drift',
    ok: false,
    severity: 'error',
    detail:
      `${site} cites '${pointer.raw}' but its anchor ${quoted} is at ` +
      `${pointer.target}:${nearest.line}, not in the cited range — repoint it to ` +
      `line ${nearest.line}, or drop the line number and keep the anchor so the ` +
      'citation cannot decay again',
    file: pointer.file,
    line: pointer.line,
    pointer: pointer.raw,
    occurrence: pointer.occurrence,
  };
}

// Verifies every anchored, resolved pointer, reading each distinct target once.
//
// Degenerate input never manufactures findings: a target that cannot be read
// contributes nothing at all rather than one "broken anchor" per citation of
// it — the same discipline principle-citations.mjs applies when its own
// reference doc fails to parse, where one root cause must not surface as
// dozens of findings that mask it. A pointer that is unresolved, ambiguous or
// an orphan continuation is exempt for the same reason it is exempt from the
// anchor-missing check: it already reports at that site, and there is no
// single target to read.
export async function verifyAnchors(repoRoot, pointers) {
  const findings = [];
  const contents = new Map();

  for (const pointer of pointers) {
    if (pointer.resolution !== 'resolved' || pointer.anchor == null) continue;
    if (pointer.target == null) continue;

    if (!contents.has(pointer.target)) {
      contents.set(pointer.target, await safeReadFile(join(repoRoot, pointer.target)));
    }
    const content = contents.get(pointer.target);
    if (content == null) continue;

    const finding = verifyAnchor(pointer, content);
    if (finding != null) findings.push(finding);
  }

  return findings;
}

// ---- the ratchet: accepted debt ----------------------------------------------

// Every check above runs at `error` severity, and this repo's corpus does not
// conform yet. The severity and the ratchet are ONE decision, not two: a corpus
// with three digits of findings cannot ship at `error` without a baseline, and
// a baseline is pointless without `error`, since a `warning` never blocks
// anything and so never ratchets.
//
// The baseline is a repo-root file, NOT a file under `plugin/`. `plugin/` is
// the published git-subdir that ships to consumers; which of *this* repo's own
// citations are accepted debt is a repo-private fact and must not travel.
//
// Its ABSENCE is the loud state, not the quiet one: with no baseline every
// non-conforming pointer is reported, so nothing has to be done to reach red. A
// baseline that is unreadable or malformed is treated exactly like an absent
// one, which fails in the same safe direction — a corrupt ratchet suppresses
// nothing rather than silently accepting everything.
export const BASELINE_FILE = '.pointer-baseline.json';

// The one and only WRITER of that file, named in both baseline findings below.
//
// Both of those findings describe a repair that ends in a baseline edit, and
// the predictable encounter is the GOOD case: a maintainer repairs a baselined
// pointer — exactly what this tool is for — and is met by a red `validate` with
// no route back to green, because the scanner is pure and the remedy lives in a
// script the finding never named. Path, not bare filename, so it can be run
// from the repo root as written.
export const BASELINE_GENERATOR = 'plugin/skills/audit-conventions/scripts/pointer-baseline.mjs';

// A short digest is enough: it is compared for equality against a value written
// by the same code, never brute-forced.
export const DIGEST_LENGTH = 12;

// The identity of an accepted pointer: its CITING FILE, its RAW POINTER TEXT,
// and its ORDINAL among identical raw pointers in that file.
//
// The citing LINE NUMBER is deliberately absent. An accepted pointer must
// survive its own document being renumbered — inserting a paragraph above a
// baselined citation moves it without changing anything about the claim it
// makes — and keying on the line number would re-fire the whole ratchet on
// every edit, which is precisely the decay this tool exists to catch elsewhere.
//
// The FINDING KIND is also absent from the key, and is recorded on an entry for
// legibility only: an entry names one pointer's accepted state, and a reader
// pruning the file needs to see what was accepted without re-running the scan.
// The three parts are joined on NUL rather than on any printable character,
// so no path or pointer text that happens to contain the separator can make
// two different keys collide.
export function baselineKey({ file, pointer, occurrence }) {
  return [file, pointer, occurrence ?? 0].join('\u0000');
}

// A digest of the NORMALIZED text of the cited range in the TARGET.
//
// This is what stops the ratchet rotting. An accepted entry does not say "this
// pointer is fine forever"; it says "this pointer, against this content". If
// the target is later rewritten under an accepted pointer, the digest moves and
// the entry re-fires — even though no anchor broke, and even for a pointer that
// carries no anchor at all to break. Without it, baselining the 103 anchorless
// pointers would freeze them against arbitrary future edits of their targets.
//
// `normalizeForMatch` is the normalization on purpose, the same form anchor
// verification compares in: a change the verifier would consider immaterial
// (case, emphasis, indentation, wrapping) is immaterial here too.
//
// Returns null when there is nothing to digest — no target, no cited range, or
// a range wholly outside the target. Null is not an error; it is the null-target
// case below, and it never drifts.
export function digestCitedRange(content, ranges) {
  if (typeof content !== 'string' || !Array.isArray(ranges) || ranges.length === 0) return null;
  const lines = content.split(/\r?\n/);
  const parts = [];
  for (const range of ranges) {
    for (let number = range.start; number <= range.end; number++) {
      const line = lines[number - 1];
      if (line === undefined) continue;
      parts.push(normalizeForMatch(line));
    }
  }
  if (parts.length === 0) return null;
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, DIGEST_LENGTH);
}

// Reads the baseline. `{ present, entries }` — `present: false` for absent,
// unreadable, malformed, or structurally wrong, all of which suppress nothing.
//
// Accepts either a bare array of entries or `{ entries: [...] }`, so the file
// can carry a `version`/comment envelope without the reader caring.
export async function loadBaseline(repoRoot, opts = {}) {
  const name = opts.baselineFile ?? BASELINE_FILE;
  const raw = await safeReadFile(join(repoRoot, name));
  if (raw == null) return { present: false, entries: [] };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: false, entries: [] };
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : parsed != null && Array.isArray(parsed.entries)
      ? parsed.entries
      : null;
  if (rows == null) return { present: false, entries: [] };

  const entries = rows
    .filter((row) => row != null && typeof row.file === 'string' && typeof row.pointer === 'string')
    .map((row) => ({
      file: row.file,
      pointer: row.pointer,
      occurrence: Number.isInteger(row.occurrence) ? row.occurrence : 0,
      kind: typeof row.kind === 'string' ? row.kind : null,
      digest: typeof row.digest === 'string' ? row.digest : null,
    }));
  return { present: true, entries };
}

// Applies the baseline to a scan's findings. Pure — the caller owns both reads.
//
// Four outcomes, and the last two are the ratchet:
//
//   - baseline absent                    → every finding passes through;
//   - matched, digest unchanged          → suppressed;
//   - matched, digest CHANGED            → `pointer-baseline-drifted`, because
//                                          the target moved under an accepted
//                                          pointer and the acceptance no longer
//                                          describes what is there;
//   - entry matched by NOTHING           → `pointer-baseline-stale`, because
//                                          the pointer was fixed or deleted and
//                                          the entry must be pruned or it will
//                                          silently re-accept a future pointer
//                                          that lands on the same key.
//
// THE NULL-TARGET CASE. An ambiguous, unresolved or orphan-continuation finding
// has no single target, hence no cited range and no digest. Such findings are
// still fully STORABLE — 32 of this repo's 138 findings today — and
// they are suppressed on a key match like any other. They can never fire
// `pointer-baseline-drifted`, because there is nothing to compare: a drift
// verdict requires two digests, and a missing digest on EITHER side means the
// comparison is not available rather than failed.
export function applyBaseline(findings, baseline) {
  if (baseline == null || !baseline.present) return findings;

  const byKey = new Map(baseline.entries.map((entry) => [baselineKey(entry), entry]));
  const matched = new Set();
  const kept = [];

  for (const finding of findings) {
    const key = baselineKey(finding);
    const entry = byKey.get(key);
    if (entry === undefined) {
      kept.push(finding);
      continue;
    }
    matched.add(key);

    if (entry.digest == null || finding.digest == null) continue;
    if (entry.digest === finding.digest) continue;

    kept.push({
      kind: 'pointer-baseline-drifted',
      ok: false,
      severity: 'error',
      detail:
        `${finding.file}:${finding.line} accepts '${finding.pointer}' in ${BASELINE_FILE}, but ` +
        `the content it cites has changed since the baseline was taken (${entry.digest} → ` +
        `${finding.digest}) — the acceptance no longer describes the cited lines, so re-read ` +
        'the target and either repair the citation, or re-take the entry by deleting it from ' +
        `${BASELINE_FILE} and running \`node ${BASELINE_GENERATOR} --write --accept-new\``,
      file: finding.file,
      line: finding.line,
      pointer: finding.pointer,
      occurrence: finding.occurrence,
      digest: finding.digest,
      baselineDigest: entry.digest,
    });
  }

  for (const entry of baseline.entries) {
    if (matched.has(baselineKey(entry))) continue;
    kept.push({
      kind: 'pointer-baseline-stale',
      ok: false,
      severity: 'error',
      detail:
        `${BASELINE_FILE} accepts '${entry.pointer}' in ${entry.file}, but the current scan ` +
        'reports nothing there — the pointer was repaired or removed, so prune the entry with ' +
        `\`node ${BASELINE_GENERATOR} --write\` (prune-only is that command's default), or ` +
        'the ratchet will silently re-accept the next pointer that lands on the same key',
      file: entry.file,
      pointer: entry.pointer,
      occurrence: entry.occurrence,
      digest: null,
    });
  }

  return kept;
}

// Attaches each finding's target digest, reading every distinct target once.
//
// Digests are computed whether or not a baseline exists, so the generator that
// WRITES the baseline can take them straight off a plain scan rather than
// duplicating the keying and hashing rules that live here.
async function attachDigests(repoRoot, findings, pointers) {
  const byKey = new Map(
    pointers.map((pointer) => [
      baselineKey({ file: pointer.file, pointer: pointer.raw, occurrence: pointer.occurrence }),
      pointer,
    ]),
  );
  const contents = new Map();
  const out = [];

  for (const finding of findings) {
    const pointer = byKey.get(baselineKey(finding));
    let digest = null;
    let target = null;
    if (pointer != null && pointer.resolution === 'resolved' && pointer.target != null) {
      target = pointer.target;
      if (!contents.has(target)) {
        contents.set(target, await safeReadFile(join(repoRoot, target)));
      }
      digest = digestCitedRange(contents.get(target), pointer.ranges);
    }
    out.push({ ...finding, target, digest });
  }

  return out;
}

// ---- scanPointerAnchors ------------------------------------------------------

// `opts` is forwarded to `collectPointers` for signature parity with
// hygiene.mjs's scanners; the corpus decisions above are contract, not
// preference, so nothing there is configurable. Two options ARE read here, both
// about the ratchet rather than the checking:
//
//   - `baselineFile` — the baseline's path, relative to `repoRoot`;
//   - `useBaseline: false` — scan as if no baseline existed, which is how the
//     generator obtains the unsuppressed findings it writes one from.
export async function scanPointerAnchors(repoRoot, opts = {}) {
  const { pointers, findings } = await collectPointers(repoRoot, opts);
  const raw = [...findings, ...(await verifyAnchors(repoRoot, pointers))];
  const withDigests = await attachDigests(repoRoot, raw, pointers);
  if (opts.useBaseline === false) return withDigests;
  return applyBaseline(withDigests, await loadBaseline(repoRoot, opts));
}
