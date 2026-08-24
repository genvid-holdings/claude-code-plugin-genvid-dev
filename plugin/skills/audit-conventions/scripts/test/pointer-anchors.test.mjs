import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  BASELINE_FILE,
  BASELINE_GENERATOR,
  applyBaseline,
  baselineKey,
  buildTargetIndex,
  collectPointers,
  digestCitedRange,
  extractAnchor,
  findAnchorOccurrences,
  listCitingFiles,
  listTargetCandidates,
  loadBaseline,
  matchCandidates,
  normalizeAnchorText,
  normalizeForMatch,
  parseLineSpec,
  parsePointersInLine,
  scanPointerAnchors,
  stripEmphasisMarkers,
  verifyAnchor,
  verifyAnchors,
} from '../lib/pointer-anchors.mjs';

// ---- fixture plumbing --------------------------------------------------------

async function withTempRepo(setup) {
  const dir = await mkdtemp(join(tmpdir(), 'pointer-anchors-test-'));
  try {
    await setup(dir);
    return dir;
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

async function writeRepoFile(dir, rel, content) {
  const path = join(dir, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

// The repo-root half of the citing corpus is scoped by `git ls-files`, so the
// fixtures that exercise it have to be real git repos. `git add` alone is
// enough — `gitTrackedFiles` reads the index, so no commit and no configured
// identity are needed.
function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

// Every fixture pointer is ASSEMBLED at runtime rather than spelled out.
//
// `.mjs` is one of the two citing file types the scanner under test walks, and
// this test file lives inside the citing corpus — so a literal `path.ext:NN`
// written anywhere below would be a genuine pointer in the plugin's own repo,
// minting findings against fixture paths that will never exist. Concatenating
// around the colon keeps the fixtures readable without that side effect.
const COLON = ':';
const ptr = (path, spec) => path + COLON + spec;
const span = (text) => '`' + text + '`';
const cite = (path, spec) => span(ptr(path, spec));
const cont = (spec) => span(COLON + spec);

// A file of `n` numbered lines — used where a fixture target needs a specific
// length. Deliberately synthetic: no real repo file's length is ever pinned,
// so these assertions cannot decay when a real file grows.
const numberedLines = (n) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// ---- parseLineSpec -----------------------------------------------------------

test('parseLineSpec: a single line becomes a one-line range', () => {
  assert.deepEqual(parseLineSpec('83'), [{ start: 83, end: 83 }]);
});

test('parseLineSpec: a range keeps both endpoints', () => {
  assert.deepEqual(parseLineSpec('313-314'), [{ start: 313, end: 314 }]);
});

test('parseLineSpec: a comma-compound yields one range per part', () => {
  assert.deepEqual(parseLineSpec('29,159-163'), [
    { start: 29, end: 29 },
    { start: 159, end: 163 },
  ]);
});

// ---- parsePointersInLine: grammar -------------------------------------------

test('parsePointersInLine: parses a plain single-line pointer', () => {
  const line = `See ${cite('plugin/agents/analyst.md', '59')} for the rule.`;
  const [p] = parsePointersInLine(line);
  assert.equal(p.citedPath, 'plugin/agents/analyst.md');
  assert.equal(p.lineSpec, '59');
  assert.deepEqual(p.ranges, [{ start: 59, end: 59 }]);
  assert.equal(p.isContinuation, false);
});

test('parsePointersInLine: parses a range pointer', () => {
  const line = `As of ${cite('maintain-wiki/SKILL.md', '313-314')} this holds.`;
  const [p] = parsePointersInLine(line);
  assert.equal(p.citedPath, 'maintain-wiki/SKILL.md');
  assert.deepEqual(p.ranges, [{ start: 313, end: 314 }]);
});

test('parsePointersInLine: parses a comma-compound pointer', () => {
  const line = `Both ${cite('maintain-wiki/SKILL.md', '29,159-163')} apply.`;
  const [p] = parsePointersInLine(line);
  assert.equal(p.lineSpec, '29,159-163');
  assert.deepEqual(p.ranges, [
    { start: 29, end: 29 },
    { start: 159, end: 163 },
  ]);
});

test('parsePointersInLine: parses a non-md target extension', () => {
  const line = `Config at ${cite('.gvt-agent.json', '26')} and code at ${cite('lib/migrate.mjs', '864')}.`;
  const parsed = parsePointersInLine(line);
  assert.deepEqual(
    parsed.map((p) => p.citedPath),
    ['.gvt-agent.json', 'lib/migrate.mjs'],
  );
});

test('parsePointersInLine: parses a pointer written without backticks', () => {
  const line = `  // ${ptr('SKILL.md', '265-273')} explains why.`;
  const [p] = parsePointersInLine(line);
  assert.equal(p.citedPath, 'SKILL.md');
  assert.equal(p.enclosed, false);
});

test('parsePointersInLine: a path with no line spec is not a pointer', () => {
  assert.deepEqual(parsePointersInLine('The `analyst.md` body says so.'), []);
});

test('parsePointersInLine: a backslash-escaped path fragment is not a pointer', () => {
  // A regex literal in a `.mjs` citing file — admitting a backslash into the
  // path class would parse these escapes as a cited path.
  const bs = String.fromCharCode(92);
  const line = `assert.match(f.detail, /docs${bs}/foo${bs}.md${COLON}1 contains/);`;
  assert.deepEqual(parsePointersInLine(line), []);
});

// ---- parsePointersInLine: delimiter awareness --------------------------------

test('parsePointersInLine: delimiterEnd lands past the pointer closing backtick', () => {
  const line = `See ${cite('plugin/agents/analyst.md', '59')} ("the exact anchor text").`;
  const [p] = parsePointersInLine(line);
  assert.equal(p.enclosed, true);
  // The pointer text itself stops at the last digit...
  assert.equal(line.slice(p.start, p.end), ptr('plugin/agents/analyst.md', '59'));
  assert.equal(line[p.end], '`');
  // ...but the DELIMITER end is past the closing backtick, so a later stage
  // looking for an anchor after `delimiterEnd` cannot mistake the pointer's own
  // closing backtick for an anchor's opening one.
  assert.equal(line[p.delimiterEnd], ' ');
  assert.equal(line.slice(p.delimiterStart, p.delimiterEnd), cite('plugin/agents/analyst.md', '59'));
});

test('parsePointersInLine: an undelimited pointer reports delimiterEnd at its own end', () => {
  const line = `  // ${ptr('SKILL.md', '265-273')} explains why.`;
  const [p] = parsePointersInLine(line);
  assert.equal(p.enclosed, false);
  assert.equal(p.delimiterEnd, p.end);
  assert.equal(p.delimiterStart, p.start);
});

test('parsePointersInLine: pointers are returned in source order', () => {
  const line = `${cite('a.md', '1')} then ${cite('b.md', '2')} then ${cont('3')}.`;
  assert.deepEqual(
    parsePointersInLine(line).map((p) => p.lineSpec),
    ['1', '2', '3'],
  );
});

test('parsePointersInLine: a bare line spec outside a code span is not a continuation', () => {
  assert.deepEqual(parsePointersInLine(`the meeting runs 11${COLON}30 to noon`), []);
});

// ---- matchCandidates: resolution rule ----------------------------------------

test('matchCandidates: exact path match', () => {
  assert.deepEqual(matchCandidates(['a/SKILL.md', 'b/SKILL.md'], 'a/SKILL.md'), ['a/SKILL.md']);
});

test('matchCandidates: slash-boundary suffix match', () => {
  assert.deepEqual(
    matchCandidates(['plugin/agents/planner.md', 'docs/notes.md'], 'planner.md'),
    ['plugin/agents/planner.md'],
  );
});

test('matchCandidates: never matches on a bare (non-slash-boundary) suffix', () => {
  const files = ['plugin/agents/issue-triage-analyst.md', 'plugin/agents/analyst.md'];
  assert.deepEqual(matchCandidates(files, 'analyst.md'), ['plugin/agents/analyst.md']);
  assert.deepEqual(matchCandidates(files, 'issue-triage-analyst.md'), [
    'plugin/agents/issue-triage-analyst.md',
  ]);
});

// ---- defect (3): hyphen-prefixed sibling basenames ---------------------------

test('collectPointers: a hyphen-prefixed sibling is never resolved by bare suffix', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/analyst.md', numberedLines(20));
    await writeRepoFile(d, 'plugin/agents/issue-triage-analyst.md', numberedLines(20));
    await writeRepoFile(
      d,
      'docs/notes.md',
      `Short one at ${cite('analyst.md', '5')} ("line 5") and long one at ${cite('issue-triage-analyst.md', '5')} ("line 5").\n`,
    );
  });
  try {
    const { pointers, findings } = await collectPointers(dir);
    const byCited = new Map(pointers.map((p) => [p.citedPath, p]));

    // Assert the RESOLVED TARGET PATHS, not finding counts — a count can pass
    // for the wrong reason (e.g. both sides going ambiguous).
    assert.equal(byCited.get('analyst.md').target, 'plugin/agents/analyst.md');
    assert.equal(
      byCited.get('issue-triage-analyst.md').target,
      'plugin/agents/issue-triage-analyst.md',
    );
    assert.deepEqual(findings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- defect (2): shared basenames --------------------------------------------

test('collectPointers: two files sharing a basename are never conflated', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'a/SKILL.md', numberedLines(10));
    await writeRepoFile(d, 'b/SKILL.md', numberedLines(200));
    await writeRepoFile(
      d,
      'docs/notes.md',
      `Near the top of ${cite('a/SKILL.md', '5')} ("line 5"), and deep inside ${cite('b/SKILL.md', '150')} ("line 150").\n`,
    );
  });
  try {
    const { pointers, findings } = await collectPointers(dir);
    const byCited = new Map(pointers.map((p) => [p.citedPath, p]));

    assert.equal(byCited.get('a/SKILL.md').target, 'a/SKILL.md');
    // The deep citation resolves to the LONG file and is not reported as out
    // of range — the conflation defect would have measured it against the
    // 10-line sibling.
    assert.equal(byCited.get('b/SKILL.md').target, 'b/SKILL.md');
    assert.deepEqual(byCited.get('b/SKILL.md').ranges, [{ start: 150, end: 150 }]);
    assert.deepEqual(findings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectPointers: a bare shared basename is reported ambiguous', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'a/SKILL.md', numberedLines(10));
    await writeRepoFile(d, 'b/SKILL.md', numberedLines(200));
    await writeRepoFile(d, 'docs/notes.md', `See ${cite('SKILL.md', '5')}.\n`);
  });
  try {
    const findings = await scanPointerAnchors(dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'pointer-ambiguous');
    assert.equal(findings[0].severity, 'error');
    assert.equal(findings[0].file, 'docs/notes.md');
    assert.equal(findings[0].line, 1);
    assert.match(findings[0].detail, /matches 2 files/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectPointers: a path matching no file is reported unresolved', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/notes.md', `See ${cite('nowhere/gone.md', '5')}.\n`);
  });
  try {
    const findings = await scanPointerAnchors(dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'pointer-unresolved');
    assert.equal(findings[0].severity, 'error');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- continuations -----------------------------------------------------------

test('collectPointers: a continuation after a comma attaches to the preceding pointer', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/designer.md', numberedLines(120));
    await writeRepoFile(
      d,
      'docs/notes.md',
      `The rules at ${cite('designer.md', '83')} ("line 83"), ${cont('90')} ("line 90") govern this.\n`,
    );
  });
  try {
    const { pointers, findings } = await collectPointers(dir);
    assert.deepEqual(findings, []);
    assert.equal(pointers.length, 2);
    const [head, tail] = pointers;
    assert.equal(tail.isContinuation, true);
    assert.equal(tail.citedPath, head.citedPath);
    assert.equal(tail.target, 'plugin/agents/designer.md');
    assert.deepEqual(tail.ranges, [{ start: 90, end: 90 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectPointers: continuations after a slash attach to the preceding pointer', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/designer.md', numberedLines(120));
    await writeRepoFile(
      d,
      'docs/notes.md',
      `${cite('designer.md', '83')}/${cont('90')}/${cont('98')} — the three-site steer.\n`,
    );
  });
  try {
    const { pointers, findings } = await collectPointers(dir);
    // The slash-chain shape carries no anchor on any of its three links — a
    // real corpus shape, reported as such. What this test pins is the
    // ATTACHMENT, so assert no RESOLUTION finding rather than none at all.
    assert.deepEqual(
      findings.filter((f) => f.kind !== 'pointer-anchor-missing'),
      [],
    );
    assert.deepEqual(
      pointers.map((p) => [p.lineSpec, p.target]),
      [
        ['83', 'plugin/agents/designer.md'],
        ['90', 'plugin/agents/designer.md'],
        ['98', 'plugin/agents/designer.md'],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectPointers: a continuation attaches across lines within one paragraph', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/designer.md', numberedLines(120));
    await writeRepoFile(
      d,
      'docs/notes.md',
      `The rule at ${cite('designer.md', '83')} ("line 83") was rejected as the extension\n` +
        `point, since ${cont('90')} ("line 90") sits in group 1 instead.\n`,
    );
  });
  try {
    const { pointers, findings } = await collectPointers(dir);
    assert.deepEqual(findings, []);
    const tail = pointers[1];
    assert.equal(tail.line, 2);
    assert.equal(tail.target, 'plugin/agents/designer.md');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectPointers: a continuation with no preceding pointer is an orphan', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/notes.md', `The bullet at ${cont('83')} says otherwise.\n`);
  });
  try {
    const { pointers, findings } = await collectPointers(dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'pointer-orphan-continuation');
    assert.equal(findings[0].severity, 'error');
    assert.equal(findings[0].line, 1);
    assert.equal(pointers[0].resolution, 'orphan');
    assert.equal(pointers[0].target, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectPointers: a blank line ends the paragraph, orphaning a later continuation', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/designer.md', numberedLines(120));
    await writeRepoFile(
      d,
      'docs/notes.md',
      `First para cites ${cite('designer.md', '83')} ("line 83").\n\nSecond para cites ${cont('90')}.\n`,
    );
  });
  try {
    const findings = await scanPointerAnchors(dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'pointer-orphan-continuation');
    assert.equal(findings[0].line, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- non-pointers ------------------------------------------------------------

test('collectPointers: a bare path mention with no line number yields no finding', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/analyst.md', numberedLines(20));
    await writeRepoFile(
      d,
      'docs/notes.md',
      'The `analyst.md` body and README.md both describe this; see nonexistent.md too.\n',
    );
  });
  try {
    const { pointers, findings } = await collectPointers(dir);
    assert.deepEqual(findings, []);
    assert.deepEqual(pointers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectPointers: fenced content is not scanned', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(
      d,
      'docs/notes.md',
      ['Prose above.', '', '```', `${cite('nowhere/gone.md', '5')}`, `${cont('9')}`, '```', '', 'Prose below.', ''].join(
        '\n',
      ),
    );
  });
  try {
    const { pointers, findings } = await collectPointers(dir);
    assert.deepEqual(findings, []);
    assert.deepEqual(pointers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- anchor extraction: the search text --------------------------------------

// The text an anchor is searched in: everything after the pointer's ENCLOSING
// delimiter. Derived through the real parser rather than a hand-counted offset,
// so a test can never disagree with the module about where the delimiter ends.
const tailAfter = (line, pointerIndex = 0) => {
  const pointer = parsePointersInLine(line)[pointerIndex];
  return line.slice(pointer.delimiterEnd);
};

// The same, for an anchor that wraps: the pointer's own line plus the following
// source line, joined exactly as the scanner joins them.
const wrappedTailAfter = (first, second) => `${tailAfter(first)}\n${second}`;

// ---- anchor extraction: the three declared forms -----------------------------

test('extractAnchor: a straight double-quoted span is an anchor', () => {
  const anchor = extractAnchor(tailAfter(`See ${cite('a/analyst.md', '59')} ("the exact anchor text").`));
  assert.equal(anchor.form, 'quoted');
  assert.equal(anchor.quoteStyle, 'straight');
  assert.equal(anchor.connector, '(');
  assert.equal(anchor.text, 'the exact anchor text');
  assert.equal(anchor.raw, '"the exact anchor text"');
  assert.equal(anchor.hasElision, false);
  assert.deepEqual(anchor.fragments, ['the exact anchor text']);
});

test('extractAnchor: a curly double-quoted span is an anchor', () => {
  const anchor = extractAnchor(tailAfter(`See ${cite('a/analyst.md', '59')}, “the curly span”.`));
  assert.equal(anchor.form, 'quoted');
  assert.equal(anchor.quoteStyle, 'curly');
  assert.equal(anchor.connector, ',');
  assert.equal(anchor.text, 'the curly span');
});

test('extractAnchor: a colon-introduced quoted span is its own form', () => {
  const anchor = extractAnchor(tailAfter(`See ${cite('a/analyst.md', '59')}: "the introduced span".`));
  assert.equal(anchor.form, 'colon-quoted');
  assert.equal(anchor.connector, ':');
  assert.equal(anchor.text, 'the introduced span');
});

test('extractAnchor: a backticked identifier is an anchor', () => {
  const anchor = extractAnchor(tailAfter(`See ${cite('lib/migrate.mjs', '864')} — ${span('scanDanglingReferences')} lives there.`));
  assert.equal(anchor.form, 'backticked');
  assert.equal(anchor.quoteStyle, null);
  assert.equal(anchor.connector, '—');
  assert.equal(anchor.text, 'scanDanglingReferences');
});

test('extractAnchor: nothing after the pointer at all is no anchor', () => {
  assert.equal(extractAnchor(tailAfter(`Ends at ${cite('a/analyst.md', '59')}`)), null);
});

test('extractAnchor: more than one connector character is no anchor', () => {
  // The window admits at most one connector, so a second one is prose as far as
  // the grammar is concerned.
  assert.equal(extractAnchor(tailAfter(`See ${cite('a/analyst.md', '59')}, ; "not an anchor".`)), null);
});

// ---- anchor extraction: named real-corpus shapes -----------------------------
//
// All five are shapes this repo carries live, reproduced here (with the pointer
// assembled at runtime) so the grammar is pinned against real prose rather than
// against invented examples. The two negatives are the discriminating half: the
// possessive cases below differ from `designer.md`'s possessive ONLY in what
// follows the connector.

test('extractAnchor: real shape — migrate.mjs pointer, possessive + backticked identifier', () => {
  const line = `- **${cite('migrate.mjs', '862')}'s ${span('scanDanglingReferences')}** still hardcodes`;
  const anchor = extractAnchor(tailAfter(line));
  assert.equal(anchor.form, 'backticked');
  assert.equal(anchor.possessive, true);
  assert.equal(anchor.connector, null);
  assert.equal(anchor.text, 'scanDanglingReferences');
});

test('extractAnchor: real shape — hygiene.mjs pointer, possessive + backticked identifier', () => {
  const line = `Verified unchanged: ${cite('hygiene.mjs', '18')}'s ${span('DEFAULT_EXCLUDE_PATHS')} and ${span('listCandidateFiles')} walk docs only.`;
  const anchor = extractAnchor(tailAfter(line));
  assert.equal(anchor.form, 'backticked');
  assert.equal(anchor.possessive, true);
  assert.equal(anchor.text, 'DEFAULT_EXCLUDE_PATHS');
});

test('extractAnchor: real shape — code-reviewer.md pointer, paren connector + elided span wrapped across lines', () => {
  // Verbatim shape from the corpus: the quoted anchor opens at the end of one
  // line and closes on the next, whose continuation is INDENTED.
  const first = `   single pre-committed target"), ${cite('plugin/agents/code-reviewer.md', '96')} ("the`;
  const second = '   fixed target both … independently check against") — because the graders';
  const anchor = extractAnchor(wrappedTailAfter(first, second));
  assert.equal(anchor.form, 'quoted');
  assert.equal(anchor.connector, '(');
  assert.equal(anchor.wrapped, true);
  assert.equal(anchor.hasElision, true);
  // Whitespace RUNS are squeezed, not merely swapped for spaces — the
  // continuation line's indentation would otherwise survive into the text.
  assert.equal(anchor.text, 'the fixed target both … independently check against');
  assert.ok(!/ {2}/.test(anchor.text));
  assert.deepEqual(anchor.fragments, ['the fixed target both', 'independently check against']);
});

test('extractAnchor: real shape — split-branch pointer inside parens followed by prose is NOT an anchor', () => {
  const line = `(see ${cite('plugin/skills/split-branch/SKILL.md', '136')}), so it reconstructs the tree only`;
  assert.equal(extractAnchor(tailAfter(line)), null);
});

test('extractAnchor: real shape — designer.md pointer, possessive + plain prose is NOT an anchor', () => {
  // The direct contrast with the two possessive cases above: same possessive,
  // no quoted or backticked span after it.
  const line = `1. **Widening ${cite('designer.md', '83')}'s zero-hit positive-control bullet to cover a`;
  assert.equal(extractAnchor(tailAfter(line)), null);
});

test('extractAnchor: real shape — designer.md pointer, quoted span italicized inside its connector paren', () => {
  // The `(*"…"*)` shape, verbatim from the corpus and the only occurrence of it
  // there: the emphasis markers sit OUTSIDE the quotes, so a grammar that
  // allowed a connector then a quote but nothing between them read this
  // genuinely anchored pointer as carrying no anchor at all.
  const first = `${cite('designer.md', '89')} (*"Measure the baseline by running the row's own command`;
  const second = 'against the pre-change tree — never assert one from reading the file"*);';
  const anchor = extractAnchor(wrappedTailAfter(first, second));
  assert.equal(anchor.form, 'quoted');
  assert.equal(anchor.connector, '(');
  assert.equal(anchor.wrapped, true);
  // The markers are consumed by the grammar, so neither the stored text nor
  // the raw span carries them.
  assert.equal(
    anchor.text,
    "Measure the baseline by running the row's own command against the pre-change tree — never assert one from reading the file",
  );
  assert.ok(!anchor.raw.includes('*'));
  assert.equal(anchor.raw.startsWith('"'), true);
  assert.equal(anchor.raw.endsWith('"'), true);
});

test('extractAnchor: an underscore-emphasized quoted span is an anchor', () => {
  const anchor = extractAnchor(tailAfter(`See ${cite('a/analyst.md', '59')} (__"the emphasized span"__).`));
  assert.equal(anchor.text, 'the emphasized span');
  assert.equal(anchor.raw, '"the emphasized span"');
});

test('extractAnchor: emphasis alone is not a connector — plain prose after it is still no anchor', () => {
  const line = `See ${cite('a/analyst.md', '59')} is *how* the rule is stated.`;
  assert.equal(extractAnchor(tailAfter(line)), null);
});

// ---- anchor extraction: artifact guards --------------------------------------

test('extractAnchor: a sibling pointer after a comma is not read as a backticked anchor', () => {
  // A proximity grammar reads the NEXT pointer's code span as this pointer's
  // anchor. Requiring identifier shape (no colon, no slash) rules it out.
  const line = `Both ${cite('a/validator.md', '34')}, ${cite('a/code-reviewer.md', '96')} apply.`;
  assert.equal(extractAnchor(tailAfter(line)), null);
});

test('extractAnchor: a backticked path fragment carrying a slash is not an identifier anchor', () => {
  const line = `See ${cite('a/analyst.md', '59')}, ${span('plugin/agents/')} holds it.`;
  assert.equal(extractAnchor(tailAfter(line)), null);
});

test('extractAnchor: a backticked span carrying whitespace is not an identifier anchor', () => {
  // The third exclusion, alongside the slash and the colon above. All three
  // survive the hyphen being admitted below — a hyphen was never what kept a
  // run of prose or a sibling citation out.
  const line = `See ${cite('a/analyst.md', '59')}, ${span('two words')} follow.`;
  assert.equal(extractAnchor(tailAfter(line)), null);
});

// ---- anchor extraction: kebab-case identifiers -------------------------------
//
// Skill names, agent names and hyphenated module filenames are among the most
// common backticked spans this repo writes, so a grammar that rejected them
// told authors to write an anchor they had already written.

test('extractAnchor: a kebab-case name is an identifier anchor', () => {
  const anchor = extractAnchor(tailAfter(`See ${cite('a/analyst.md', '59')} — ${span('plan-task')} owns it.`));
  assert.equal(anchor.form, 'backticked');
  assert.equal(anchor.text, 'plan-task');
});

test('extractAnchor: a hyphenated filename is an identifier anchor', () => {
  const anchor = extractAnchor(tailAfter(`See ${cite('a/analyst.md', '59')}, ${span('md-scan.mjs')} applies.`));
  assert.equal(anchor.form, 'backticked');
  assert.equal(anchor.text, 'md-scan.mjs');
});

test('extractAnchor: a bare elision quotes nothing and is not an anchor', () => {
  assert.equal(extractAnchor(tailAfter(`See ${cite('a/analyst.md', '59')} ("…").`)), null);
});

test('normalizeAnchorText: squeezes whitespace runs and trims', () => {
  assert.equal(normalizeAnchorText('  the\n   fixed  target\t\tboth '), 'the fixed target both');
});

// ---- anchor extraction: the renumber-proof shape -----------------------------

test('extractAnchor: a path mention with no line number still yields an anchor', () => {
  // The shape a decayed positional citation is repaired INTO: an anchor with no
  // line number to decay. Extraction never consults the line spec, so the same
  // connector window applies.
  const mention = span('hygiene.mjs');
  const line = `Verified unchanged: ${mention}'s ${span('DEFAULT_EXCLUDE_PATHS')} walks docs only.`;
  const anchor = extractAnchor(line.slice(line.indexOf(mention) + mention.length));
  assert.equal(anchor.form, 'backticked');
  assert.equal(anchor.possessive, true);
  assert.equal(anchor.text, 'DEFAULT_EXCLUDE_PATHS');
});

test('collectPointers: the renumber-proof shape is no pointer at all, so it reports nothing', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/skills/s/scripts/lib/hygiene.mjs', numberedLines(60));
    await writeRepoFile(
      d,
      'docs/notes.md',
      `Verified unchanged: ${span('hygiene.mjs')}'s ${span('DEFAULT_EXCLUDE_PATHS')} walks docs only.\n`,
    );
  });
  try {
    const { pointers, findings } = await collectPointers(dir);
    assert.deepEqual(pointers, []);
    assert.deepEqual(findings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- pointer-anchor-missing --------------------------------------------------

test('collectPointers: a resolved pointer with an anchor reports nothing and carries the anchor', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/skills/s/scripts/lib/migrate.mjs', numberedLines(900));
    await writeRepoFile(
      d,
      'docs/notes.md',
      `- **${cite('migrate.mjs', '862')}'s ${span('scanDanglingReferences')}** still hardcodes\n`,
    );
  });
  try {
    const { pointers, findings } = await collectPointers(dir);
    assert.deepEqual(findings, []);
    assert.equal(pointers[0].anchor.text, 'scanDanglingReferences');
    assert.equal(pointers[0].anchor.line, 1);
    // The recorded position bounds the anchor INCLUDING its delimiters.
    assert.equal(pointers[0].lineText.slice(pointers[0].anchor.column, pointers[0].anchor.endColumn), span('scanDanglingReferences'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectPointers: a resolved pointer with no anchor reports pointer-anchor-missing', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/designer.md', numberedLines(120));
    await writeRepoFile(
      d,
      'docs/notes.md',
      `1. **Widening ${cite('designer.md', '83')}'s zero-hit positive-control bullet to cover a case.**\n`,
    );
  });
  try {
    const findings = await scanPointerAnchors(dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'pointer-anchor-missing');
    assert.equal(findings[0].severity, 'error');
    assert.equal(findings[0].file, 'docs/notes.md');
    assert.equal(findings[0].line, 1);
    assert.match(findings[0].detail, /no content anchor/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectPointers: an anchor wrapped onto an indented continuation line is found', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/code-reviewer.md', numberedLines(200));
    await writeRepoFile(
      d,
      'docs/notes.md',
      `   single pre-committed target"), ${cite('plugin/agents/code-reviewer.md', '96')} ("the\n` +
        '   fixed target both … independently check against") — because the graders\n',
    );
  });
  try {
    const { pointers, findings } = await collectPointers(dir);
    assert.deepEqual(findings, []);
    assert.equal(pointers.length, 1);
    assert.equal(pointers[0].anchor.text, 'the fixed target both … independently check against');
    assert.equal(pointers[0].anchor.hasElision, true);
    // The anchor OPENS on the pointer's own line and CLOSES on the next.
    assert.equal(pointers[0].anchor.line, 1);
    assert.equal(pointers[0].anchor.endLine, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectPointers: an anchor never runs past a blank line into the next paragraph', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/designer.md', numberedLines(120));
    await writeRepoFile(
      d,
      'docs/notes.md',
      `The rule at ${cite('designer.md', '83')} ("the\n\nzero-hit rule") is elsewhere.\n`,
    );
  });
  try {
    const findings = await scanPointerAnchors(dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'pointer-anchor-missing');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectPointers: a continuation is anchor-checked on its own', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/designer.md', numberedLines(120));
    await writeRepoFile(
      d,
      'docs/notes.md',
      `The rules at ${cite('designer.md', '83')} ("the zero-hit rule"), ${cont('90')} ("the control rule") govern this.\n` +
        `\nBut ${cite('designer.md', '98')} ("the diff rule"), ${cont('99')} does not.\n`,
    );
  });
  try {
    const { pointers, findings } = await collectPointers(dir);
    // Three of the four carry their own anchor; only the last continuation
    // does not, and it is the only reported site.
    assert.deepEqual(
      pointers.map((p) => [p.lineSpec, p.anchor === null ? null : p.anchor.text]),
      [
        ['83', 'the zero-hit rule'],
        ['90', 'the control rule'],
        ['98', 'the diff rule'],
        ['99', null],
      ],
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'pointer-anchor-missing');
    assert.equal(findings[0].line, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectPointers: an unresolved pointer is not also reported anchor-missing', async () => {
  // It already reports at that site, and an anchor cannot be held against a
  // target that could not be identified.
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/notes.md', `See ${cite('nowhere/gone.md', '5')} and nothing else.\n`);
  });
  try {
    const findings = await scanPointerAnchors(dir);
    assert.deepEqual(
      findings.map((f) => f.kind),
      ['pointer-unresolved'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectPointers: an orphan continuation is not also reported anchor-missing', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/notes.md', `The bullet at ${cont('83')} says otherwise.\n`);
  });
  try {
    const findings = await scanPointerAnchors(dir);
    assert.deepEqual(
      findings.map((f) => f.kind),
      ['pointer-orphan-continuation'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- corpus scoping ----------------------------------------------------------

test('listCitingFiles: takes .md and .mjs under docs/ and plugin/, including the changelog', async () => {
  // No `git init` here, so the repo-root half contributes nothing and this
  // stays a test of the two citing TREES alone — `examples/CLAUDE.md` is out
  // because `examples/` is not a citing root, and the root `CLAUDE.md` is out
  // because there is no index to prove it tracked (asserted directly below).
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/notes.md', 'x\n');
    await writeRepoFile(d, 'plugin/CHANGELOG.md', 'x\n');
    await writeRepoFile(d, 'plugin/skills/s/scripts/lib/thing.mjs', 'x\n');
    await writeRepoFile(d, 'plugin/skills/s/config.json', '{}\n');
    await writeRepoFile(d, 'CLAUDE.md', 'x\n');
    await writeRepoFile(d, 'examples/CLAUDE.md', 'x\n');
  });
  try {
    assert.deepEqual(await listCitingFiles(dir), [
      'docs/notes.md',
      'plugin/CHANGELOG.md',
      'plugin/skills/s/scripts/lib/thing.mjs',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listCitingFiles: takes the repo root own tracked markdown, and no untracked file', async () => {
  const dir = await withTempRepo(async (d) => {
    git(d, ['init', '-q', '.']);
    await writeRepoFile(d, 'docs/notes.md', 'x\n');
    await writeRepoFile(d, 'CLAUDE.md', 'x\n');
    await writeRepoFile(d, 'README.md', 'x\n');
    await writeRepoFile(d, '.gitignore', 'plan.md\n');
    // The gitignored working artifact. Present on disk, absent from the index.
    await writeRepoFile(d, 'plan.md', 'x\n');
    await writeRepoFile(d, 'notes.json', '{}\n');
    git(d, ['add', 'docs/notes.md', 'CLAUDE.md', 'README.md', '.gitignore', 'notes.json']);
  });
  try {
    assert.deepEqual(await listCitingFiles(dir), ['CLAUDE.md', 'README.md', 'docs/notes.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listCitingFiles: absent git, the repo root contributes nothing rather than failing', async () => {
  // The graceful-degradation half: `gitTrackedFiles` returns null outside a
  // git repo, and the tree walk must survive it untouched.
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/notes.md', 'x\n');
    await writeRepoFile(d, 'CLAUDE.md', 'x\n');
    await writeRepoFile(d, 'README.md', 'x\n');
  });
  try {
    assert.deepEqual(await listCitingFiles(dir), ['docs/notes.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The constraint most likely to be silently lost later, so it is pinned end to
// end rather than at the corpus-listing seam alone.
//
// An untracked root document is not merely noise to filter: this repo's
// planning artifacts carry pointers in bulk, including the very strings the
// sibling guard test forbids the baseline from ever accepting. Scanning
// one would mint findings that can be neither repaired (the artifact is not
// the branch's to edit) nor accepted. The POSITIVE CONTROL is what makes the
// absence meaningful — the same pointer shape, written into a tracked root
// file in the same fixture, must be reported.
test('scanPointerAnchors: a pointer in a gitignored root document is never reported, while the same shape in a tracked one is', async () => {
  const dir = await withTempRepo(async (d) => {
    git(d, ['init', '-q', '.']);
    await writeRepoFile(d, '.gitignore', 'plan.md\n');
    await writeRepoFile(d, 'CLAUDE.md', `Tracked cites ${cite('tracked/gone.mjs', '12')}\n`);
    await writeRepoFile(d, 'plan.md', `Untracked cites ${cite('untracked/gone.mjs', '12')}\n`);
    git(d, ['add', '.gitignore', 'CLAUDE.md']);
  });
  try {
    const findings = await scanPointerAnchors(dir);
    // POSITIVE CONTROL: the shape IS detected, from the tracked root file.
    assert.deepEqual(
      findings.map((f) => ({ kind: f.kind, file: f.file })),
      [{ kind: 'pointer-unresolved', file: 'CLAUDE.md' }],
    );
    // THE CONSTRAINT: nothing at all came from the untracked artifact.
    assert.equal(
      findings.some((f) => f.file === 'plan.md' || f.pointer?.includes('untracked/gone.mjs')),
      false,
    );
    assert.equal((await listCitingFiles(dir)).includes('plan.md'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listCitingFiles: excludes the eval fixture tree', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/notes.md', 'x\n');
    await writeRepoFile(d, 'audit-conventions-evals/fixtures/legacy/CLAUDE.md', 'x\n');
  });
  try {
    assert.deepEqual(await listCitingFiles(dir), ['docs/notes.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listTargetCandidates: spans the whole repo but skips the eval fixture tree', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'CLAUDE.md', 'x\n');
    await writeRepoFile(d, 'docs/notes.md', 'x\n');
    await writeRepoFile(d, 'plugin/skeleton/.gvt-agent.json', '{}\n');
    await writeRepoFile(d, 'audit-conventions-evals/fixtures/legacy/CLAUDE.md', 'x\n');
    await writeRepoFile(d, '.git/config', 'x\n');
  });
  try {
    assert.deepEqual(await listTargetCandidates(dir), [
      'CLAUDE.md',
      'docs/notes.md',
      'plugin/skeleton/.gvt-agent.json',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectPointers: a target inside the eval fixture tree is not a resolution candidate', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/CONVENTIONS.md', numberedLines(120));
    await writeRepoFile(d, 'audit-conventions-evals/fixtures/migrated-gap/CONVENTIONS.md', 'x\n');
    await writeRepoFile(d, 'docs/notes.md', `See ${cite('CONVENTIONS.md', '82')} ("line 82").\n`);
  });
  try {
    const { pointers, findings } = await collectPointers(dir);
    assert.deepEqual(findings, []);
    assert.equal(pointers[0].target, 'plugin/CONVENTIONS.md');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- degenerate input --------------------------------------------------------

test('scanPointerAnchors: an empty repo yields no findings', async () => {
  const dir = await withTempRepo(async () => {});
  try {
    assert.deepEqual(await scanPointerAnchors(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scanPointerAnchors: a nonexistent repo root yields no findings', async () => {
  const dir = await withTempRepo(async () => {});
  await rm(dir, { recursive: true, force: true });
  assert.deepEqual(await scanPointerAnchors(dir), []);
});

// ---- normalization for comparison --------------------------------------------

test('stripEmphasisMarkers: markdown emphasis goes, an intra-word underscore stays', () => {
  assert.equal(stripEmphasisMarkers('do **not** treat the copy'), 'do not treat the copy');
  assert.equal(stripEmphasisMarkers('_emphasis_ here'), 'emphasis here');
  // An identifier is not emphasized prose — collapsing it would equate it with
  // a different identifier spelled without the underscores.
  assert.equal(stripEmphasisMarkers('DEFAULT_EXCLUDE_PATHS'), 'DEFAULT_EXCLUDE_PATHS');
  assert.equal(stripEmphasisMarkers('snake_case_name'), 'snake_case_name');
});

test('normalizeForMatch: squeezes whitespace, folds case, and drops emphasis', () => {
  assert.equal(normalizeForMatch('  The  **Fixed**\n   Target '), 'the fixed target');
});

test('buildTargetIndex: joins lines into one searchable string with a line map', () => {
  const index = buildTargetIndex('  alpha\n\n   beta\ngamma\n');
  // Blank lines contribute nothing; the rest join with a single space, their
  // own indentation already normalized away.
  assert.equal(index.text, 'alpha beta gamma');
  assert.deepEqual(index.marks, [
    { offset: 0, line: 1 },
    { offset: 6, line: 3 },
    { offset: 11, line: 4 },
  ]);
});

test('findAnchorOccurrences: fragments match in order, spanning target lines', () => {
  const index = buildTargetIndex('alpha and\nomega below\n');
  assert.deepEqual(findAnchorOccurrences(index, ['alpha', 'omega']), [{ line: 1, endLine: 2 }]);
  // Reversed order is not a match — ordered containment, not "both present".
  assert.deepEqual(findAnchorOccurrences(index, ['omega', 'alpha']), []);
});

// ---- verification: the three outcomes ----------------------------------------

// A target whose lines are spelled out, so the line a finding names can be read
// straight off the fixture.
const linesOf = (...lines) => lines.join('\n') + '\n';

const ANCHOR_PHRASE = 'do not treat the committed copy as ground truth';

// A four-line target carrying ANCHOR_PHRASE on line 3.
const phraseTarget = linesOf(
  'Refresh refreshable artifacts before diffing against them.',
  'Surface freshness as an explicit pre-analysis step.',
  `When a documented refresh command exists, ${ANCHOR_PHRASE}.`,
  'Treat any mismatch set as provisional.',
);

test('verification: an anchor inside the cited line range reports nothing', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/analyst.md', phraseTarget);
    await writeRepoFile(d, 'docs/notes.md', `See ${cite('analyst.md', '3')} ("${ANCHOR_PHRASE}").\n`);
  });
  try {
    assert.deepEqual(await scanPointerAnchors(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verification: an anchor found elsewhere in the target drifts, naming the real line', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/analyst.md', phraseTarget);
    await writeRepoFile(d, 'docs/notes.md', `See ${cite('analyst.md', '1')} ("${ANCHOR_PHRASE}").\n`);
  });
  try {
    const findings = await scanPointerAnchors(dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'pointer-anchor-drift');
    assert.equal(findings[0].severity, 'error');
    // file/line are the CITING site, matching principle-citations.mjs's shape.
    assert.equal(findings[0].file, 'docs/notes.md');
    assert.equal(findings[0].line, 1);
    // The correct line is named, in the target's own coordinates, so the
    // repair is mechanical.
    assert.ok(findings[0].detail.includes(ptr('plugin/agents/analyst.md', '3')));
    assert.match(findings[0].detail, /line 3/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verification: an anchor absent from the target entirely is broken, not drifted', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/analyst.md', phraseTarget);
    await writeRepoFile(
      d,
      'docs/notes.md',
      `See ${cite('analyst.md', '3')} ("a sentence this target has never contained").\n`,
    );
  });
  try {
    const findings = await scanPointerAnchors(dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'pointer-anchor-broken');
    assert.equal(findings[0].severity, 'error');
    assert.equal(findings[0].file, 'docs/notes.md');
    assert.equal(findings[0].line, 1);
    assert.match(findings[0].detail, /appears nowhere in/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- verification: the nearest occurrence ------------------------------------

test('verification: drift names the nearest occurrence, above or below the cited line', async () => {
  // The identifier appears TWICE, on either side of both citations — so a
  // first-occurrence rule and a last-occurrence rule each get exactly one of
  // the two answers wrong.
  const target = linesOf(
    'const noop = 1;',
    'const other = 2;',
    '// renderReport is described up here, far from its definition',
    ...Array.from({ length: 16 }, (_, i) => `const filler${i} = ${i};`),
    'export function renderReport() {',
    '  return null;',
    '}',
  );
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/skills/s/scripts/lib/report.mjs', target);
    await writeRepoFile(
      d,
      'docs/notes.md',
      `The definition at ${cite('lib/report.mjs', '17')} — ${span('renderReport')} — moved.\n` +
        `\nThe comment at ${cite('lib/report.mjs', '6')} — ${span('renderReport')} — moved too.\n`,
    );
  });
  try {
    // Pin the fixture's own shape first: a drift line asserted against a
    // miscounted fixture would be a test grading itself.
    const index = buildTargetIndex(target);
    assert.deepEqual(
      findAnchorOccurrences(index, ['renderreport']),
      [
        { line: 3, endLine: 3 },
        { line: 20, endLine: 20 },
      ],
    );

    const findings = await scanPointerAnchors(dir);
    assert.deepEqual(
      findings.map((f) => [f.kind, f.line]),
      [
        ['pointer-anchor-drift', 1],
        ['pointer-anchor-drift', 3],
      ],
    );
    // Cited 17: 20 is three lines below, 3 is fourteen above — nearest is below.
    assert.match(findings[0].detail, /line 20/);
    // Cited 6: 3 is three lines above, 20 is fourteen below — nearest is above.
    assert.match(findings[1].detail, /line 3/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- verification: elision, wrapping, indentation, emphasis ------------------

test('verification: an elided anchor matches as ordered containment', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(
      d,
      'plugin/agents/code-reviewer.md',
      linesOf(
        'The checklist (see ADR-0017) is the header.',
        'It is the fixed target both the validator and this review independently check against.',
      ),
    );
    await writeRepoFile(
      d,
      'docs/notes.md',
      `See ${cite('code-reviewer.md', '2')} ("the fixed target both … independently check against").\n`,
    );
  });
  try {
    // The literal quoted string — elision character and all — is nowhere in the
    // target, so a substring match would report this as broken.
    assert.deepEqual(await scanPointerAnchors(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verification: an elided anchor whose fragments occur out of order is broken', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(
      d,
      'plugin/agents/code-reviewer.md',
      linesOf('The header.', 'independently check against the fixed target both, in that order.'),
    );
    await writeRepoFile(
      d,
      'docs/notes.md',
      `See ${cite('code-reviewer.md', '2')} ("the fixed target both … independently check against").\n`,
    );
  });
  try {
    const findings = await scanPointerAnchors(dir);
    assert.deepEqual(
      findings.map((f) => f.kind),
      ['pointer-anchor-broken'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verification: a target line indented differently from the citation still matches', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(
      d,
      'plugin/agents/analyst.md',
      linesOf('Rules:', `        ${ANCHOR_PHRASE}`, 'End.'),
    );
    await writeRepoFile(d, 'docs/notes.md', `See ${cite('analyst.md', '2')} ("${ANCHOR_PHRASE}").\n`);
  });
  try {
    assert.deepEqual(await scanPointerAnchors(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verification: an anchor the TARGET wraps across two indented lines still matches', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(
      d,
      'plugin/agents/analyst.md',
      linesOf('Rules:', '  When a refresh command exists, do not treat the', '     committed copy as ground truth.', 'End.'),
    );
    await writeRepoFile(
      d,
      'docs/notes.md',
      // The cited RANGE covers both lines the phrase spans.
      `See ${cite('analyst.md', '2-3')} ("${ANCHOR_PHRASE}").\n`,
    );
  });
  try {
    assert.deepEqual(await scanPointerAnchors(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verification: emphasis and case in the target do not defeat a match', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(
      d,
      'plugin/agents/analyst.md',
      linesOf('Rules:', 'When a refresh command exists, **do NOT treat** the committed copy as ground truth.'),
    );
    await writeRepoFile(d, 'docs/notes.md', `See ${cite('analyst.md', '2')} ("${ANCHOR_PHRASE}").\n`);
  });
  try {
    assert.deepEqual(await scanPointerAnchors(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verification: the emphasis-wrapped corpus shape verifies against its target', async () => {
  // The Part-1 extraction fix carried through to verification: the same
  // `(*"…"*)` pointer that used to read as carrying no anchor is now checked
  // against the target, and passes for the right reason.
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(
      d,
      'plugin/agents/designer.md',
      linesOf('Criteria rules:', '  - **Measure the baseline by running the row\'s own command.**', 'End.'),
    );
    await writeRepoFile(
      d,
      'docs/notes.md',
      `owned at ${cite('designer.md', '2')} (*"Measure the baseline by running the row's own command"*);\n`,
    );
  });
  try {
    const { pointers } = await collectPointers(dir);
    assert.equal(pointers[0].anchor.text, "Measure the baseline by running the row's own command");
    assert.deepEqual(await scanPointerAnchors(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- verification: the renumber-proof shape ----------------------------------

test('verification: an anchored mention with no line number is conforming', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(
      d,
      'plugin/skills/s/scripts/lib/hygiene.mjs',
      linesOf('const a = 1;', 'const b = 2;', 'export const DEFAULT_EXCLUDE_PATHS = [];'),
    );
    await writeRepoFile(
      d,
      'docs/notes.md',
      // Two citations of one target with the SAME anchor. The positional one
      // has decayed; the unpositioned one cannot. Only the first is reported —
      // which is the whole argument the drift finding makes to the author.
      `Stale: ${cite('hygiene.mjs', '1')}'s ${span('DEFAULT_EXCLUDE_PATHS')} is the default set.\n` +
        `\nDurable: ${span('hygiene.mjs')}'s ${span('DEFAULT_EXCLUDE_PATHS')} is the default set.\n`,
    );
  });
  try {
    const findings = await scanPointerAnchors(dir);
    assert.deepEqual(
      findings.map((f) => [f.kind, f.line]),
      [['pointer-anchor-drift', 1]],
    );
    assert.match(findings[0].detail, /line 3/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verifyAnchor: with no cited range, present anywhere is conforming and absent is broken', () => {
  // Exercised directly: the grammar only mints a pointer when a line spec is
  // written, so an unpositioned anchor reaches verification only from a caller
  // that supplies one — pinning the rule here keeps it from silently changing.
  const anchor = extractAnchor(`'s ${span('DEFAULT_EXCLUDE_PATHS')} is the default set.`);
  const pointer = {
    file: 'docs/notes.md',
    line: 1,
    raw: 'hygiene.mjs',
    target: 'plugin/skills/s/scripts/lib/hygiene.mjs',
    ranges: [],
    resolution: 'resolved',
    anchor,
  };
  assert.equal(verifyAnchor(pointer, linesOf('export const DEFAULT_EXCLUDE_PATHS = [];')), null);
  assert.equal(verifyAnchor(pointer, linesOf('export const SOMETHING_ELSE = [];')).kind, 'pointer-anchor-broken');
});

// ---- verification: exemptions and degenerate input ---------------------------

test('verification: an ambiguous pointer with an anchor is never verified', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'a/SKILL.md', phraseTarget);
    await writeRepoFile(d, 'b/SKILL.md', phraseTarget);
    await writeRepoFile(d, 'docs/notes.md', `See ${cite('SKILL.md', '1')} ("${ANCHOR_PHRASE}").\n`);
  });
  try {
    // The anchor has drifted in both candidates, but there is no single target
    // to read — the site already reports its ambiguity.
    const findings = await scanPointerAnchors(dir);
    assert.deepEqual(
      findings.map((f) => f.kind),
      ['pointer-ambiguous'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verifyAnchors: an unreadable target manufactures no findings', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/analyst.md', phraseTarget);
    await writeRepoFile(
      d,
      'docs/notes.md',
      `First ${cite('analyst.md', '1')} ("${ANCHOR_PHRASE}").\n` +
        `\nSecond ${cite('analyst.md', '4')} ("${ANCHOR_PHRASE}").\n`,
    );
  });
  try {
    const { pointers } = await collectPointers(dir);
    // Positive control: with the target readable, BOTH citations report drift —
    // so the empty result below is the read failing, not the check being
    // vacuous.
    assert.equal((await verifyAnchors(dir, pointers)).length, 2);

    await rm(join(dir, 'plugin/agents/analyst.md'));
    assert.deepEqual(await verifyAnchors(dir, pointers), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scanPointerAnchors: a citing root that is absent contributes nothing', async () => {
  const dir = await withTempRepo(async (d) => {
    // No docs/ at all; only plugin/ exists.
    await writeRepoFile(d, 'plugin/agents/designer.md', numberedLines(120));
    await writeRepoFile(d, 'plugin/CHANGELOG.md', `Bumped ${cite('designer.md', '79')} ("line 79").\n`);
  });
  try {
    assert.deepEqual(await scanPointerAnchors(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the ratchet: keying ------------------------------------------------------

test('baselineKey: the citing LINE NUMBER is not part of the key', () => {
  // The renumber-survival property, stated at the level of the key itself: two
  // findings for the same pointer differing only in where it sits in its own
  // document are the same accepted pointer.
  const at = (line) => ({ file: 'docs/notes.md', pointer: ptr('designer.md', '83'), occurrence: 0, line });
  assert.equal(baselineKey(at(1)), baselineKey(at(400)));
});

test('baselineKey: file, pointer text and occurrence each discriminate', () => {
  const base = { file: 'docs/notes.md', pointer: ptr('designer.md', '83'), occurrence: 0 };
  const key = baselineKey(base);
  assert.notEqual(key, baselineKey({ ...base, file: 'docs/other.md' }));
  assert.notEqual(key, baselineKey({ ...base, pointer: ptr('designer.md', '84') }));
  assert.notEqual(key, baselineKey({ ...base, occurrence: 1 }));
  // A missing occurrence is the first one.
  assert.equal(key, baselineKey({ file: base.file, pointer: base.pointer }));
});

test('collectPointers: identical raw pointers in one file get successive occurrence indices', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/designer.md', numberedLines(120));
    await writeRepoFile(
      d,
      'docs/notes.md',
      `First mention of ${cite('designer.md', '83')} here.\n` +
        `\nSecond mention of ${cite('designer.md', '83')} there.\n`,
    );
  });
  try {
    const { pointers } = await collectPointers(dir);
    assert.deepEqual(
      pointers.map((p) => [p.line, p.occurrence]),
      [
        [1, 0],
        [3, 1],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the ratchet: the digest --------------------------------------------------

test('digestCitedRange: nothing to digest yields null, never a hash of emptiness', () => {
  const content = linesOf('alpha', 'beta', 'gamma');
  assert.equal(digestCitedRange(content, []), null);
  assert.equal(digestCitedRange(null, [{ start: 1, end: 1 }]), null);
  // A range wholly past the end of the target: the null-target case, not a
  // digest that would then compare equal to every other out-of-range citation.
  assert.equal(digestCitedRange(content, [{ start: 90, end: 92 }]), null);
});

test('digestCitedRange: only the CITED lines are digested', () => {
  const before = linesOf('alpha', 'beta', 'gamma');
  const after = linesOf('alpha', 'beta', 'REWRITTEN');
  const cited = [{ start: 2, end: 2 }];
  assert.equal(digestCitedRange(before, cited), digestCitedRange(after, cited));
  assert.notEqual(
    digestCitedRange(before, [{ start: 3, end: 3 }]),
    digestCitedRange(after, [{ start: 3, end: 3 }]),
  );
});

test('digestCitedRange: normalization-equivalent target text digests the same', () => {
  // The same normalization anchor verification compares in — a change the
  // verifier would call immaterial must not fire the ratchet either.
  const plain = linesOf('When a refresh command exists, do not treat the copy as truth.');
  const dressed = linesOf('    When a refresh command exists, **do NOT treat** the copy as truth.');
  const cited = [{ start: 1, end: 1 }];
  assert.equal(digestCitedRange(plain, cited), digestCitedRange(dressed, cited));
});

// ---- the ratchet: fixtures ----------------------------------------------------

// One anchorless pointer into a fixture target — the shape 103 of this repo's
// own findings have. (Its site is named through `cite` below rather than spelled
// out in this comment, for the reason the header gives: a literal one here would
// be a real pointer in the plugin's own corpus.) Its finding does not depend on
// the TARGET's content at all, which is what lets the drift mutation below
// change the target and still have a finding present to compare digests against.
const ANCHORLESS_CITATION = `1. **Widening ${cite('designer.md', '83')}'s zero-hit positive-control bullet.**\n`;

async function ratchetFixture(lead = '') {
  return withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/designer.md', numberedLines(120));
    await writeRepoFile(d, 'docs/notes.md', lead + ANCHORLESS_CITATION);
  });
}

// Exactly what the P6 generator will write: the identity fields plus the digest,
// taken straight off an unsuppressed scan. Building the fixture baseline this
// way — rather than hand-writing entries — pins that a finding really does carry
// everything an entry needs.
const entriesFrom = (findings) =>
  findings.map((f) => ({
    file: f.file,
    pointer: f.pointer,
    occurrence: f.occurrence,
    kind: f.kind,
    digest: f.digest,
  }));

const writeBaseline = (dir, findings) =>
  writeRepoFile(dir, BASELINE_FILE, JSON.stringify({ version: 1, entries: entriesFrom(findings) }, null, 2) + '\n');

const replaceLine = (content, number, text) => {
  const lines = content.split('\n');
  lines[number - 1] = text;
  return lines.join('\n');
};

// ---- the ratchet: absent baseline is the loud state ---------------------------

test('ratchet: with no baseline file every non-conforming pointer is reported', async () => {
  const dir = await ratchetFixture();
  try {
    const findings = await scanPointerAnchors(dir);
    assert.deepEqual(
      findings.map((f) => [f.kind, f.file, f.line]),
      [['pointer-anchor-missing', 'docs/notes.md', 1]],
    );
    // The finding carries its own baseline identity and a digest of the cited
    // range, so a generator needs nothing the scan did not already produce.
    assert.equal(findings[0].pointer, ptr('designer.md', '83'));
    assert.equal(findings[0].occurrence, 0);
    assert.equal(findings[0].target, 'plugin/agents/designer.md');
    assert.equal(typeof findings[0].digest, 'string');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ratchet: a malformed baseline suppresses nothing', async () => {
  const dir = await ratchetFixture();
  try {
    const findings = await scanPointerAnchors(dir);
    await writeBaseline(dir, findings);
    assert.deepEqual(await scanPointerAnchors(dir), []);

    // Corrupting the file must fail toward RED, not toward accepting everything.
    await writeRepoFile(dir, BASELINE_FILE, '{ this is not json\n');
    assert.deepEqual((await loadBaseline(dir)).present, false);
    assert.deepEqual(
      (await scanPointerAnchors(dir)).map((f) => f.kind),
      ['pointer-anchor-missing'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadBaseline: absent is not present, and a bare array is accepted', async () => {
  const dir = await withTempRepo(async () => {});
  try {
    assert.deepEqual(await loadBaseline(dir), { present: false, entries: [] });

    await writeRepoFile(
      dir,
      BASELINE_FILE,
      JSON.stringify([{ file: 'docs/notes.md', pointer: ptr('a.md', '1') }]) + '\n',
    );
    const baseline = await loadBaseline(dir);
    assert.equal(baseline.present, true);
    assert.deepEqual(baseline.entries, [
      { file: 'docs/notes.md', pointer: ptr('a.md', '1'), occurrence: 0, kind: null, digest: null },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the ratchet: a matching entry suppresses --------------------------------

test('ratchet: a matching entry with an unchanged digest is suppressed', async () => {
  const dir = await ratchetFixture();
  try {
    const before = await scanPointerAnchors(dir);
    assert.equal(before.length, 1);
    await writeBaseline(dir, before);
    assert.deepEqual(await scanPointerAnchors(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ratchet: an entry suppresses only its own occurrence of a repeated pointer', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'plugin/agents/designer.md', numberedLines(120));
    await writeRepoFile(
      d,
      'docs/notes.md',
      `First mention of ${cite('designer.md', '83')} here.\n` +
        `\nSecond mention of ${cite('designer.md', '83')} there.\n`,
    );
  });
  try {
    const before = await scanPointerAnchors(dir);
    assert.deepEqual(
      before.map((f) => [f.kind, f.occurrence]),
      [
        ['pointer-anchor-missing', 0],
        ['pointer-anchor-missing', 1],
      ],
    );
    await writeBaseline(dir, before.slice(0, 1));
    // Accepting the first mention leaves the second reported — an occurrence
    // index that collapsed identical pointers would have suppressed both.
    assert.deepEqual(
      (await scanPointerAnchors(dir)).map((f) => [f.kind, f.line]),
      [['pointer-anchor-missing', 3]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the ratchet: the remedy path itself -------------------------------------

// A remedy naming a script that has moved is worse than one naming none, and
// this file is where such a path would rot unnoticed. Resolved from the test's
// own location so it fails if the generator is renamed or relocated.
test('the baseline generator path names a file that really exists', async () => {
  const { access } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { resolve } = await import('node:path');
  // scripts/test -> scripts -> audit-conventions -> skills -> plugin -> root
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
  await access(join(repoRoot, BASELINE_GENERATOR));
});

// ---- the ratchet: MUTATION — the pointer is removed ⇒ stale ------------------

test('ratchet: deleting a baselined pointer from its citing file fires pointer-baseline-stale', async () => {
  const dir = await ratchetFixture();
  try {
    const before = await scanPointerAnchors(dir);
    await writeBaseline(dir, before);
    // The system starts in the ACCEPTED state, so the mutation below is the
    // only thing that can move it.
    assert.deepEqual(await scanPointerAnchors(dir), []);

    // MUTATION: the pointer is gone from the citing file — repaired or deleted.
    await writeRepoFile(dir, 'docs/notes.md', '1. **Widening the zero-hit positive-control bullet.**\n');

    const after = await scanPointerAnchors(dir);
    assert.equal(after.length, 1);
    assert.equal(after[0].kind, 'pointer-baseline-stale');
    assert.equal(after[0].severity, 'error');
    assert.equal(after[0].ok, false);
    assert.equal(after[0].file, 'docs/notes.md');
    assert.equal(after[0].pointer, ptr('designer.md', '83'));
    assert.match(after[0].detail, /prune the entry/);
    // The remedy names the script that performs it. The scanner is pure, so a
    // finding that only says "prune the entry" leaves a red validate with no
    // route to green — and the maintainer who hits it is the one who did the
    // right thing and repaired the pointer.
    assert.ok(after[0].detail.includes(BASELINE_GENERATOR));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the ratchet: MUTATION — the target moves ⇒ drifted ---------------------

test('ratchet: editing the cited line under a baselined pointer fires pointer-baseline-drifted', async () => {
  const dir = await ratchetFixture();
  try {
    const before = await scanPointerAnchors(dir);
    await writeBaseline(dir, before);
    assert.deepEqual(await scanPointerAnchors(dir), []);

    const targetPath = 'plugin/agents/designer.md';
    const original = numberedLines(120);

    // CONTROL: editing a line the pointer does NOT cite changes nothing, so the
    // assertion below is about the cited range and not about the target file
    // having been touched at all.
    await writeRepoFile(dir, targetPath, replaceLine(original, 84, 'line 84 rewritten'));
    assert.deepEqual(await scanPointerAnchors(dir), []);

    // MUTATION: the CITED line's content changes under the accepted pointer.
    await writeRepoFile(dir, targetPath, replaceLine(original, 83, 'an entirely different claim'));

    const after = await scanPointerAnchors(dir);
    assert.equal(after.length, 1);
    assert.equal(after[0].kind, 'pointer-baseline-drifted');
    assert.equal(after[0].severity, 'error');
    assert.equal(after[0].ok, false);
    assert.equal(after[0].file, 'docs/notes.md');
    assert.equal(after[0].line, 1);
    assert.equal(after[0].pointer, ptr('designer.md', '83'));
    // Both digests are named, so the entry can be re-taken deliberately.
    assert.equal(after[0].baselineDigest, before[0].digest);
    assert.notEqual(after[0].digest, before[0].digest);
    assert.ok(after[0].detail.includes(before[0].digest));
    assert.ok(after[0].detail.includes(after[0].digest));
    // …and so is the script that re-takes the entry, for the same reason the
    // stale finding names the one that prunes it.
    assert.ok(after[0].detail.includes(BASELINE_GENERATOR));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the ratchet: renumber survival -------------------------------------------

test('ratchet: an accepted pointer survives its own document being renumbered', async () => {
  const dir = await ratchetFixture();
  try {
    const before = await scanPointerAnchors(dir);
    assert.equal(before[0].line, 1);
    await writeBaseline(dir, before);
    assert.deepEqual(await scanPointerAnchors(dir), []);

    // MUTATION: two lines inserted ABOVE the citation. Nothing about the claim
    // it makes changed; only where it sits in its own file did.
    await writeRepoFile(dir, 'docs/notes.md', 'A new opening paragraph.\n\n' + ANCHORLESS_CITATION);

    // Control: the citing line really did move, so the suppression below is not
    // passing because the mutation failed to land.
    const unratcheted = await scanPointerAnchors(dir, { useBaseline: false });
    assert.deepEqual(
      unratcheted.map((f) => [f.kind, f.line]),
      [['pointer-anchor-missing', 3]],
    );

    assert.deepEqual(await scanPointerAnchors(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the ratchet: the null-target case ---------------------------------------

test('ratchet: null-target findings round-trip through the baseline and never drift', async () => {
  // All three kinds that have no single target — the shape 32 of this repo's
  // 138 findings have, including the ambiguous ADR citations.
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'a/SKILL.md', numberedLines(200));
    await writeRepoFile(d, 'b/SKILL.md', numberedLines(200));
    await writeRepoFile(
      d,
      'docs/decisions/0022-bundle-root.md',
      `The tier rule at ${cite('SKILL.md', '159')} ("line 159") governs this.\n` +
        `\nGone: ${cite('nowhere/removed.md', '5')} ("line 5").\n` +
        `\nThe bullet at ${cont('83')} says otherwise.\n`,
    );
  });
  try {
    const before = await scanPointerAnchors(dir);
    assert.deepEqual(before.map((f) => f.kind).sort(), [
      'pointer-ambiguous',
      'pointer-orphan-continuation',
      'pointer-unresolved',
    ]);
    // No single target ⇒ no cited range ⇒ no digest, on every one of them.
    assert.deepEqual(
      before.map((f) => f.digest),
      [null, null, null],
    );

    // They are STORABLE all the same, and a stored one suppresses.
    await writeBaseline(dir, before);
    assert.deepEqual(await scanPointerAnchors(dir), []);

    // MUTATION: both ambiguity candidates are rewritten wholesale. A design
    // that compared digests here would have nothing to compare and must not
    // invent a verdict from it.
    await writeRepoFile(dir, 'a/SKILL.md', numberedLines(40));
    await writeRepoFile(dir, 'b/SKILL.md', linesOf('a completely different document'));

    const after = await scanPointerAnchors(dir);
    assert.deepEqual(
      after.filter((f) => f.kind === 'pointer-baseline-drifted'),
      [],
    );
    assert.deepEqual(after, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('applyBaseline: a digest on one side only is not a drift verdict', () => {
  // Reached when a baselined pointer becomes ambiguous (entry has a digest, the
  // finding no longer can) or the reverse. Neither side has a comparison
  // available, so the entry suppresses without claiming the target moved.
  const finding = {
    kind: 'pointer-anchor-missing',
    ok: false,
    severity: 'error',
    detail: 'x',
    file: 'docs/notes.md',
    line: 1,
    pointer: ptr('designer.md', '83'),
    occurrence: 0,
    digest: null,
  };
  const entry = { file: 'docs/notes.md', pointer: ptr('designer.md', '83'), occurrence: 0, kind: null, digest: 'abc123abc123' };
  assert.deepEqual(applyBaseline([finding], { present: true, entries: [entry] }), []);
  assert.deepEqual(
    applyBaseline([{ ...finding, digest: 'abc123abc123' }], {
      present: true,
      entries: [{ ...entry, digest: null }],
    }),
    [],
  );
});

test('applyBaseline: an absent baseline passes every finding through untouched', () => {
  const findings = [{ kind: 'pointer-anchor-missing', file: 'docs/notes.md', line: 1, pointer: 'x', occurrence: 0, digest: null }];
  assert.equal(applyBaseline(findings, { present: false, entries: [] }), findings);
  assert.equal(applyBaseline(findings, null), findings);
});
