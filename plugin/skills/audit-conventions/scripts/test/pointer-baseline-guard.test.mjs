// Guard: the pointers this branch repaired must never be baselined away.
//
// The ratchet's `--accept-new` refuses to write while any pointer is PROVABLY
// wrong — a drift, or an anchor that no longer resolves. It does NOT refuse for
// a pointer that merely lacks an anchor, because anchorless is the accepted
// debt the baseline exists to hold. Six of the nine pointers the sweep repaired
// were in exactly that state: re-introduce one and the ratchet will happily
// accept it, and the correction is silently undone. The ordering discipline
// that protected them during the branch lived only in a plan document. This
// test is what makes it permanent.
//
// WHY THE FORBIDDEN STRINGS LIVE IN A JSON FIXTURE AND NOT IN THIS FILE
//
// `.mjs` is one of the pointer scanner's own citing extensions, and this file
// sits under `plugin/` — a citing root. A forbidden pointer spelled as a
// literal here would therefore be a live pointer finding in this repo, and it
// could not be cleared: the baseline is the only way to clear it, and this very
// test forbids those strings from entering the baseline. Unresolvable by
// construction. `.json` is not a citing extension, so the strings are inert in
// `fixtures/swept-pointers.json`, which also records where each was cited from
// and what it was corrected to. The same hazard is why the positive-control
// pointer below is assembled around its colon at runtime rather than written
// out — see the sibling generator test, which does the same for its fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { BASELINE_FILE } from '../lib/pointer-anchors.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/test -> scripts -> audit-conventions -> skills -> plugin -> repo root
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const BASELINE_PATH = join(REPO_ROOT, BASELINE_FILE);
const FIXTURE_PATH = join(__dirname, 'fixtures', 'swept-pointers.json');

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

// Both sweeps, flattened, each entry tagged with the group it came from so a
// failure message can say whether the offender is one of the pledged nine.
async function forbiddenPointers() {
  const fixture = await readJson(FIXTURE_PATH);
  return [
    ...fixture.pledgedSweep.pointers.map((p) => ({ ...p, group: 'pledgedSweep' })),
    ...fixture.additionalSweep.pointers.map((p) => ({ ...p, group: 'additionalSweep' })),
  ];
}

const distinct = (entries) => new Set(entries.map((e) => e.pointer));

// A known-accepted entry, assembled around its colon (see the header note).
// It is an ambiguous finding — no single target, hence no cited range, hence
// `digest: null`. That is supported, not malformed, so the control asserts the
// null rather than tolerating it.
const CONTROL = {
  file: 'docs/decisions/0022-okf-bundle-root-is-the-wiki-tier.md',
  pointer: 'SKILL.md' + ':' + '159',
  occurrence: 0,
  kind: 'pointer-ambiguous',
  digest: null,
};

// High enough that an empty or truncated baseline fails loudly, low enough that
// anchoring pointers over time — which legitimately shrinks the file — does not
// fail a correct future change. The count was 126 when this test was written.
const MIN_BASELINE_ENTRIES = 100;

// ---- the fixture itself ------------------------------------------------------

// Without this, emptying the fixture would turn the guard below into a vacuous
// pass — the one failure mode a data-driven guard cannot see from inside its
// own loop.
test('the swept-pointer fixture still lists the pledged nine, plus the one found later', async () => {
  const fixture = await readJson(FIXTURE_PATH);

  const pledged = fixture.pledgedSweep.pointers;
  assert.equal(pledged.length, 9, 'the pledged sweep repaired nine occurrences');
  assert.equal(
    distinct(pledged).size,
    8,
    'of eight distinct strings — one path was cited at the same line from two different ADRs',
  );
  assert.equal(pledged.length, fixture.pledgedSweep.occurrences);
  assert.equal(distinct(pledged).size, fixture.pledgedSweep.distinctPointers);

  // Kept separate on purpose: this one was found while building the scanner,
  // after the nine had been graded against the unfixed tree.
  const additional = fixture.additionalSweep.pointers;
  assert.equal(additional.length, 1);
  assert.equal(additional.length, fixture.additionalSweep.occurrences);

  // Six of the nine lacked an anchor before the fix — the state the ratchet's
  // refusal does not cover, and therefore the whole reason this guard exists.
  const anchorless = pledged.filter((p) => p.carriedAnchorBeforeFix === false);
  assert.equal(anchorless.length, 6);

  for (const entry of [...pledged, ...additional]) {
    assert.ok(entry.pointer, 'every entry names the forbidden pointer string');
    assert.ok(entry.citedFrom, `${entry.pointer} records where it was cited from`);
    assert.ok(entry.correctedTo, `${entry.pointer} records what it was corrected to`);
  }
});

// ---- the baseline envelope ---------------------------------------------------

// Split out so a corrupt or missing baseline fails here, with a message naming
// the file, rather than as a confusing TypeError inside the guard.
test('the ratchet baseline parses and carries the expected envelope', async () => {
  const baseline = await readJson(BASELINE_PATH);
  assert.equal(baseline.version, 1, `${BASELINE_FILE} envelope version`);
  assert.ok(Array.isArray(baseline.entries), `${BASELINE_FILE} carries an entries array`);
});

// ---- the guard ---------------------------------------------------------------

// The absence assertions and the positive control share one test deliberately.
// Absence alone would pass against an empty — or absent — baseline file, which
// is precisely the state this must not tolerate, so the proof that the corpus
// being searched is the real one has to be inseparable from the search.
test('no swept pointer has been baselined away, over a baseline proven non-empty', async () => {
  const baseline = await readJson(BASELINE_PATH);

  // POSITIVE CONTROL, same corpus: a known-accepted entry is really in there,
  // and the file is really populated.
  assert.ok(
    baseline.entries.length >= MIN_BASELINE_ENTRIES,
    `${BASELINE_FILE} holds ${baseline.entries.length} entries, below the floor of ` +
      `${MIN_BASELINE_ENTRIES} — an empty or truncated baseline would make the ` +
      `absence assertions below vacuous`,
  );
  const control = baseline.entries.find(
    (e) => e.file === CONTROL.file && e.pointer === CONTROL.pointer,
  );
  assert.ok(
    control,
    `the control entry (${CONTROL.pointer}, accepted from ${CONTROL.file}) is missing from ` +
      `${BASELINE_FILE} — without it, this test is not reading the baseline it thinks it is`,
  );
  assert.deepEqual(control, CONTROL);

  // THE GUARD.
  const baselined = new Set(baseline.entries.map((e) => e.pointer));
  for (const entry of await forbiddenPointers()) {
    assert.ok(
      !baselined.has(entry.pointer),
      `'${entry.pointer}' is accepted in ${BASELINE_FILE}, but it is a stale pointer this ` +
        `branch already corrected (cited from ${entry.citedFrom}, corrected to ` +
        `${entry.correctedTo}; ${entry.group}). It carried ` +
        `${entry.carriedAnchorBeforeFix ? 'an anchor' : 'NO anchor'} before the fix` +
        `${entry.carriedAnchorBeforeFix ? '' : ', which is why --accept-new would not refuse it'}` +
        `. Fix the pointer instead of baselining it; see fixtures/swept-pointers.json.`,
    );
  }
});
