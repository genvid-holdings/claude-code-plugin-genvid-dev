import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  collectPointers,
  listCitingFiles,
  listTargetCandidates,
  matchCandidates,
  parseLineSpec,
  parsePointersInLine,
  scanPointerAnchors,
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
      `Short one at ${cite('analyst.md', '5')} and long one at ${cite('issue-triage-analyst.md', '5')}.\n`,
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
      `Near the top of ${cite('a/SKILL.md', '5')}, and deep inside ${cite('b/SKILL.md', '150')}.\n`,
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
      `The rules at ${cite('designer.md', '83')}, ${cont('90')} govern this.\n`,
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
    assert.deepEqual(findings, []);
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
      `The rule at ${cite('designer.md', '83')} was rejected as the extension\n` +
        `point, since ${cont('90')} sits in group 1 instead.\n`,
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
      `First para cites ${cite('designer.md', '83')}.\n\nSecond para cites ${cont('90')}.\n`,
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

// ---- corpus scoping ----------------------------------------------------------

test('listCitingFiles: takes .md and .mjs under docs/ and plugin/, including the changelog', async () => {
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
    await writeRepoFile(d, 'docs/notes.md', `See ${cite('CONVENTIONS.md', '82')}.\n`);
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

test('scanPointerAnchors: a citing root that is absent contributes nothing', async () => {
  const dir = await withTempRepo(async (d) => {
    // No docs/ at all; only plugin/ exists.
    await writeRepoFile(d, 'plugin/agents/designer.md', numberedLines(120));
    await writeRepoFile(d, 'plugin/CHANGELOG.md', `Bumped ${cite('designer.md', '79')}.\n`);
  });
  try {
    assert.deepEqual(await scanPointerAnchors(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
