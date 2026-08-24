// Cross-references citations of `plugin/docs/development-principles.md`'s
// numbered principles (e.g. "principle #7", "principles #8", `` `development-
// principles.md` #10 ``) against that doc's actual top-level ordered list, so
// a renumbering of the shared doc doesn't silently leave stale citations
// pointing at a principle that moved or no longer exists.
//
// `(repoRoot, opts = {}) => findings[]` (async, pure — no fs writes), matching
// the shape of hygiene.mjs's scanners: `{ kind, ok: false, severity, detail }`
// plus `file`/`line` here since every finding is anchored to a specific
// citation site.
//
// Wired author-time-only from audit.mjs's AUDITING_PLUGIN_SOURCE block — a
// consumer repo can't fix the plugin's own citations, so it never runs there.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { listMarkdown } from './fs-walk.mjs';

const PRINCIPLES_DOC_PATH = 'plugin/docs/development-principles.md';

// Keyword-anchored: only matches "#N" when immediately preceded by
// "principle"/"principles" or the doc's own filename (optionally inside a
// backtick code span, e.g. `` `development-principles.md` #10 ``).
// Deliberately does NOT match keyword-less issue/PR references like "Distinct
// from #6" or a sibling project's own numbering like "construct3-chef #136" —
// those are not principle citations at all, and treating every bare "#N" as
// one would flood findings with false positives.
//
// The `\b` blocks a word-char run bleeding into the keyword ("myprinciple #4").
// It deliberately does NOT block a hyphenated compound ("sub-principles #7"):
// `-` is itself a word boundary, and that's load-bearing — the doc's own name,
// "development-principles", is hyphenated.
//
// Consequence: an illustrative example of a *bad* citation can't be written
// anywhere under plugin/ — it fires for real. Masking inline code spans first
// (as md-scan.mjs's maskInlineCode does for links) would NOT help, since the
// real form `` `development-principles.md` #11 `` puts the number outside the
// span; masking would blank the anchoring keyword and lose genuine citations.
// See ADR-0019.
const CITATION_RE = /(?:development-principles\.md`?|\bprinciples?)\s+#(\d+)/gi;

async function safeReadFile(path) {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

// ---- parsePrincipleNumbers ---------------------------------------------------

// Parses the top-level ordered list of development-principles.md (lines
// matching `/^(\d+)\.\s/` anchored at column 0 — no leading whitespace, so an
// indented/nested list item is rejected) into a Set of principle numbers.
// Fenced code blocks are skipped (the same rule md-scan.mjs's
// iterateUnfencedLines applies, which scanBrokenLinks now consumes; this
// scanner still carries its own copy) so a fenced example numbered list
// can't inflate
// the parsed set.
export function parsePrincipleNumbers(content) {
  const numbers = new Set();
  const lines = content.split('\n');
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue; // fence delimiter line itself is never a list item
    }
    if (inFence) continue;

    const match = /^(\d+)\.\s/.exec(line);
    if (match) numbers.add(Number(match[1]));
  }
  return numbers;
}

// ---- findCitations ------------------------------------------------------------

// Returns `[{ line, number }]` (1-based line numbers, in document order) for
// every principle citation found in content.
export function findCitations(content) {
  const citations = [];
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    CITATION_RE.lastIndex = 0;
    let match;
    while ((match = CITATION_RE.exec(line))) {
      citations.push({ line: idx + 1, number: Number(match[1]) });
    }
  });
  return citations;
}

// ---- scanPrincipleCitations -----------------------------------------------------

// `opts` is accepted for signature parity with hygiene.mjs's scanners but is
// deliberately unused: those filter by `excludePaths`/`retiredTokens`, whereas
// this scanner's scope is fixed (plugin/**/*.md minus CHANGELOG.md) and
// author-time-only, so there is no consuming-repo config to honour.
export async function scanPrincipleCitations(repoRoot, opts = {}) {
  const principlesContent = await safeReadFile(join(repoRoot, PRINCIPLES_DOC_PATH));
  if (principlesContent == null) return []; // no development-principles.md — nothing to check against

  const validNumbers = parsePrincipleNumbers(principlesContent);
  if (validNumbers.size === 0) {
    // An empty parsed set means the parse itself failed (the doc's shape
    // changed and parsePrincipleNumbers no longer recognizes its list) —
    // NOT that every citation in the repo is simultaneously invalid.
    // Emitting one finding per citation here would be actively misleading
    // (dozens of "bad citation" findings masking the real, single root
    // cause), so collapse to exactly one parse-failure finding instead.
    return [
      {
        kind: 'principle-citation',
        ok: false,
        severity: 'error',
        detail: `${PRINCIPLES_DOC_PATH} could not be parsed — no principles found in its top-level ordered list`,
        file: PRINCIPLES_DOC_PATH,
      },
    ];
  }

  const minNumber = Math.min(...validNumbers);
  const maxNumber = Math.max(...validNumbers);
  const rangeLabel = `${minNumber}-${maxNumber}`;

  const files = (await listMarkdown(repoRoot, 'plugin')).filter(
    (f) => f !== 'plugin/CHANGELOG.md',
  );
  const findings = [];

  for (const relPath of files) {
    const content = await safeReadFile(join(repoRoot, relPath));
    if (content == null) continue;

    for (const { line, number } of findCitations(content)) {
      if (validNumbers.has(number)) continue;
      findings.push({
        kind: 'principle-citation',
        ok: false,
        severity: 'error',
        detail: `${relPath}:${line} cites principle #${number}, which does not exist (valid: ${rangeLabel})`,
        file: relPath,
        line,
      });
    }
  }

  return findings;
}
