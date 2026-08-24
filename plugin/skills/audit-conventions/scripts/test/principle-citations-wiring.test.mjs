// Integration test: scanPrincipleCitations (lib/principle-citations.mjs) is
// wired into audit.mjs's AUDITING_PLUGIN_SOURCE block only — it must NOT fire
// when auditing a consuming repo. `audit.mjs`'s `AUDITING_PLUGIN_SOURCE` is
// path-derived from PLUGIN_ROOT (this script's own install location) sitting
// inside REPO_ROOT (the audited cwd); a temp-dir fixture repo is, by
// construction, never that, so the gate is false there — this is the
// "prove the author-time gate actively" acceptance criterion made permanent,
// sibling to hygiene-wiring.test.mjs's wiring proof for the always-on
// hygiene scanners (that file's header scopes it to those three; this gate
// has the opposite default — off unless auditing the plugin source itself —
// so it gets its own file rather than stretching that scope).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withTempMigratedRepo } from './helpers/temp-repo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/test/principle-citations-wiring.test.mjs -> scripts -> audit-conventions -> skills -> plugin
const AUDIT_PATH = resolve(__dirname, '..', 'audit.mjs');

function spawnAudit(args, cwd) {
  return spawnSync(process.execPath, [AUDIT_PATH, ...args], { cwd, encoding: 'utf8' });
}

// Builds a minimal STATE_MIGRATED temp repo (via withTempMigratedRepo)
// carrying:
//   - docs/TOC.md: condense-lessons requires it (see withTempMigratedRepo).
//   - plugin/docs/development-principles.md: a small valid 1-3 principle list.
//   - plugin/skills/foo/SKILL.md: a citation to principle #99, which does NOT
//     exist in that list.
// The #99 citation is deliberately load-bearing: if AUDITING_PLUGIN_SOURCE
// were ever true for this repo (or the gate were removed from audit.mjs), it
// WOULD produce a 'principle-citation' finding and flip the exit code to 1
// (severity 'error' — see lib/principle-citations.mjs). A fixture with only
// valid citations would pass vacuously and prove nothing about the gate
// itself; this one proves the gate actively suppresses a real, would-be
// finding when auditing a repo that is not the plugin source.
async function withTempPrincipleCitationRepo() {
  return withTempMigratedRepo(async (dir) => {
    await writeFile(join(dir, 'docs', 'TOC.md'), '# TOC\n');
    await mkdir(join(dir, 'plugin', 'docs'), { recursive: true });
    await writeFile(
      join(dir, 'plugin', 'docs', 'development-principles.md'),
      [
        '# Development Principles',
        '',
        '1. **First principle.** Some descriptive text.',
        '2. **Second principle.** Some descriptive text.',
        '3. **Third principle.** Some descriptive text.',
        '',
      ].join('\n'),
    );
    await mkdir(join(dir, 'plugin', 'skills', 'foo'), { recursive: true });
    await writeFile(
      join(dir, 'plugin', 'skills', 'foo', 'SKILL.md'),
      ['# Foo', '', 'See principle #99 for details.', ''].join('\n'),
    );
  });
}

test('audit: principle-citation scanner does NOT run against a consuming repo, even with a bogus citation present', async () => {
  const tmpDir = await withTempPrincipleCitationRepo();
  try {
    const result = spawnAudit([], tmpDir);

    assert.doesNotMatch(
      result.stdout,
      /cites principle #99/,
      'the principle-citation scanner is author-time-only (AUDITING_PLUGIN_SOURCE) and must not fire ' +
        'when auditing a consuming repo, even though this fixture carries a citation that would trip it',
    );

    // CRITICAL: the gate held, so nothing escalated to 'error' — the audit
    // must exit 0 despite the bogus #99 citation sitting right there.
    assert.equal(
      result.status,
      0,
      `audit must exit 0: the bogus #99 citation must not fire outside the plugin source:\n${result.stdout}`,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
