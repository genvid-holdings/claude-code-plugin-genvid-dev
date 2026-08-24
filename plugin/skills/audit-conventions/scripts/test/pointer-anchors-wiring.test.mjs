// Integration test: scanPointerAnchors (lib/pointer-anchors.mjs) is wired into
// audit.mjs's AUDITING_PLUGIN_SOURCE block only — it must NOT fire when
// auditing a consuming repo. AUDITING_PLUGIN_SOURCE is path-derived from
// PLUGIN_ROOT (this script's own install location) sitting inside REPO_ROOT
// (the audited cwd); a temp-dir fixture repo is, by construction, never that,
// so the gate is false there.
//
// The gate matters MORE for this scanner than for the principle-citation one
// it is modelled on. That scanner reads only the plugin's own tree, so a
// consumer's audit has nothing for it to walk. This scanner's citing corpus
// includes the repo-root `docs/` tree — `docs/decisions/` very much included,
// a directory `create-adr` scaffolds into consuming repos — so ungated it
// would grade a consumer's own ADR prose at `error` severity and fail their
// `commands.validate`. Hence this fixture plants its would-be finding exactly
// there.
//
// Sibling to principle-citations-wiring.test.mjs (same gate, opposite scanner)
// and hygiene-wiring.test.mjs (the always-on scanners' wiring proof).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withTempMigratedRepo } from './helpers/temp-repo.mjs';
import { scanPointerAnchors } from '../lib/pointer-anchors.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/test/pointer-anchors-wiring.test.mjs -> scripts
const AUDIT_PATH = resolve(__dirname, '..', 'audit.mjs');

// The fixture's planted pointer, ASSEMBLED AT RUNTIME rather than written as a
// literal. This file is itself a `.mjs` under `plugin/`, i.e. part of the
// scanner's own citing corpus, so spelling a path-and-line pointer out here
// would mint a real one against this repo and move its finding count.
const CITED_FILE = 'CLAUDE.md';
const CITED_LINE = 1;
const PLANTED_POINTER = `${CITED_FILE}:${CITED_LINE}`;

function spawnAudit(args, cwd) {
  return spawnSync(process.execPath, [AUDIT_PATH, ...args], { cwd, encoding: 'utf8' });
}

// Builds a minimal STATE_MIGRATED temp repo (via withTempMigratedRepo)
// carrying:
//   - docs/TOC.md: condense-lessons requires it (see withTempMigratedRepo).
//   - docs/decisions/0001-fixture.md: an ADR citing CLAUDE.md by line with NO
//     content anchor after the pointer.
//
// The unanchored pointer is deliberately load-bearing. It resolves — the temp
// repo's CLAUDE.md is a real, unambiguous target — and carries no anchor, so
// if AUDITING_PLUGIN_SOURCE were ever true for this repo (or the gate were
// removed from audit.mjs) it WOULD produce a `pointer-anchor-missing` finding
// at severity 'error' and flip the exit code to 1. A fixture with nothing to
// find would pass whether or not the gate works; this one proves the gate
// actively suppresses a real, would-be finding.
async function withTempPointerAnchorRepo() {
  return withTempMigratedRepo(async (dir) => {
    await writeFile(join(dir, 'docs', 'TOC.md'), '# TOC\n');
    await mkdir(join(dir, 'docs', 'decisions'), { recursive: true });
    await writeFile(
      join(dir, 'docs', 'decisions', '0001-fixture.md'),
      [
        '# 1. Fixture decision',
        '',
        'The repo contract is stated at `' + PLANTED_POINTER + '` and we follow it.',
        '',
      ].join('\n'),
    );
  });
}

test('audit: pointer-anchor scanner does NOT run against a consuming repo, even with an unanchored pointer present', async () => {
  const tmpDir = await withTempPointerAnchorRepo();
  try {
    // POSITIVE CONTROL, run first: the scanner itself, called directly against
    // the same fixture, must report the planted pointer at 'error' severity.
    // Without this the suppression assertions below could pass because the
    // fixture is inert rather than because the gate holds.
    const direct = await scanPointerAnchors(tmpDir);
    const planted = direct.filter((f) => f.pointer === PLANTED_POINTER);
    assert.ok(
      planted.length >= 1,
      `fixture is vacuous: scanPointerAnchors reported nothing for the planted pointer:\n${JSON.stringify(direct, null, 2)}`,
    );
    assert.ok(
      planted.some((f) => f.severity === 'error'),
      "the planted pointer must be an 'error'-severity finding, or the gate proof below is about nothing",
    );

    const result = spawnAudit([], tmpDir);

    // Assert on the RENDERED detail text, not on the finding's `kind`. Kinds
    // are never printed — formatReport emits `- ${f.detail}` — so a regex over
    // the kind string would not match even with the gate removed, and the
    // check would be vacuous in the one direction it exists to catch.
    assert.ok(
      !result.stdout.includes(PLANTED_POINTER),
      'the pointer-anchor scanner is author-time-only (AUDITING_PLUGIN_SOURCE) and must not fire ' +
        `when auditing a consuming repo, but its planted pointer was reported:\n${result.stdout}`,
    );
    assert.ok(
      !result.stdout.includes('with no content anchor'),
      `no pointer-anchor finding of any kind may be reported for a consuming repo:\n${result.stdout}`,
    );

    // CRITICAL: the gate held, so nothing escalated to 'error' — the audit
    // must exit 0 despite the unanchored pointer sitting right there.
    assert.equal(
      result.status,
      0,
      `audit must exit 0: the unanchored pointer must not fire outside the plugin source:\n${result.stdout}`,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
