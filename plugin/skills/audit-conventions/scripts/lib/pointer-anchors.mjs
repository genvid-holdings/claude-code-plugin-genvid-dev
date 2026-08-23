// Finds and resolves positional `path:line` pointers written in this repo's
// prose and code comments, so a pointer that has decayed against a moved
// target can be detected instead of silently misleading a reader.
//
// This module is the FIRST stage only: it selects the citing corpus, parses
// pointers together with their enclosing delimiters, and resolves each cited
// path to a real file. Anchor extraction and anchor verification are separate,
// later stages that consume `collectPointers`' output — nothing here reads a
// target's content.
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
// delimiter alongside the pointer: a later stage looks for a content anchor
// AFTER the pointer, and a grammar that stopped at the pointer's last digit
// would read the pointer's own closing backtick as an anchor's opening
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
export async function collectPointers(repoRoot, opts = {}) {
  const candidates = await listTargetCandidates(repoRoot);
  const citingFiles = await listCitingFiles(repoRoot);

  const pointers = [];
  const findings = [];

  for (const relPath of citingFiles) {
    const content = await safeReadFile(join(repoRoot, relPath));
    if (content == null) continue;

    let previousLineNumber = 0;
    let paragraph = 0;
    let lastResolved = null;

    for (const { lineNumber, text } of iterateUnfencedLines(content)) {
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
