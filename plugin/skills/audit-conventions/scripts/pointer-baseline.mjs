#!/usr/bin/env node
// Generates and prunes the pointer-anchor ratchet baseline.
//
// THE SCANNER NEVER WRITES. lib/pointer-anchors.mjs is pure: it reads the
// citing corpus, reads targets, and returns findings. This script is the one
// and only writer of the baseline file — which is why it is a peer of audit.mjs
// rather than a module under lib/. lib/ holds importable logic; this is an
// executable entry point. Every rule about what an entry IS — the key, the
// digest, the envelope the reader accepts — lives in lib/pointer-anchors.mjs
// and is imported here, never restated.
//
// Usage:
//   node pointer-baseline.mjs [repoPath] [--write] [--accept-new]
//
//   (bare)        Print the diff this run WOULD apply. Writes nothing.
//   --write       Apply it.
//   --accept-new  Also ADD entries for findings not already in the baseline.
//
// PRUNE-ONLY IS THE DEFAULT, with or without --write: entries matching nothing
// in the current scan are removed, and nothing is added. That default exists
// because the baseline is a whole-value store with two writers — add and prune —
// and no diff view once it has been written. A wholesale regeneration would
// silently re-accept every finding introduced since the last run, which is the
// clobber this default exists to prevent; prune-only makes accepting new debt a
// separate, explicit act.
//
// A KEPT ENTRY IS PASSED THROUGH VERBATIM, digest included. Re-taking a digest
// is neither an add nor a prune, so this script never does it: a
// pointer-baseline-drifted finding means the target moved under an accepted
// pointer, and resolving it is a decision — repair the citation, or delete the
// entry and re-accept it deliberately — not a regeneration.
//
// --accept-new REFUSES, with a non-zero exit and no write, while any
// pointer-anchor-drift or pointer-anchor-broken finding exists. Those two kinds
// mean a pointer is provably wrong: the anchor sits elsewhere in the target, or
// nowhere in it at all. Baselining a known-wrong pointer would undercut the
// tool's own premise. Repair them first, then accept the rest.
//
// KNOWN GAP, DELIBERATE. The refusal covers pointer-anchor-drift and
// pointer-anchor-broken. It does NOT cover pointer-anchor-missing — so a newly
// added pointer carrying no content anchor can still be accepted by
// --accept-new without complaint. This gate is not the defence against that; a
// separate guard test pins the specific pointers that must never be baselined.
//
// Exit codes: 0 success (including a dry run with pending changes); 1 the
// --accept-new refusal; 2 a usage error.

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  BASELINE_FILE,
  baselineKey,
  loadBaseline,
  scanPointerAnchors,
} from './lib/pointer-anchors.mjs';

// The two finding kinds that block --accept-new. Both mean the citation is
// provably wrong about its target, as opposed to merely uncheckable
// (pointer-anchor-missing) or unresolvable (pointer-ambiguous,
// pointer-unresolved, pointer-orphan-continuation).
const BLOCKING_KINDS = ['pointer-anchor-drift', 'pointer-anchor-broken'];

const USAGE = [
  'Usage: node pointer-baseline.mjs [repoPath] [--write] [--accept-new]',
  '',
  '  (bare)        Print the diff this run would apply. Writes nothing.',
  '  --write       Apply it.',
  '  --accept-new  Also add entries for findings not already in the baseline.',
  '  --help        Print this text.',
  '',
  'Prune-only is the default, with or without --write: entries matching nothing',
  'in the current scan are removed and nothing is added. The baseline is a',
  'whole-value store with no diff view once written, so a wholesale regeneration',
  'would silently re-accept every finding introduced since the last run.',
  '',
  'A kept entry is passed through verbatim, digest included. This script never',
  're-takes a digest: a drifted acceptance is a decision to make by hand.',
  '',
  '--accept-new refuses, with a non-zero exit and no write, while any',
  'pointer-anchor-drift or pointer-anchor-broken finding exists — baselining a',
  'provably wrong pointer would undercut the premise of the check.',
  '',
  'Known gap, deliberate: that refusal covers pointer-anchor-drift and',
  'pointer-anchor-broken only. It does NOT cover pointer-anchor-missing, so a',
  'newly added pointer with no content anchor can still be accepted by',
  '--accept-new without complaint. A separate guard test, not this gate, pins',
  'the specific pointers that must never be baselined.',
].join('\n');

function parseArgs(argv) {
  const args = { repoPath: undefined, write: false, acceptNew: false, help: false };
  for (const arg of argv) {
    if (arg === '--write') args.write = true;
    else if (arg === '--accept-new') args.acceptNew = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('-')) return { error: `unknown option '${arg}'` };
    else if (args.repoPath === undefined) args.repoPath = arg;
    else return { error: `unexpected extra argument '${arg}'` };
  }
  return args;
}

// The identity fields plus the digest — taken straight off a finding, because a
// finding already carries everything an entry needs. `kind` is recorded for a
// reader's benefit and is deliberately not part of the key.
const entryFrom = (finding) => ({
  file: finding.file,
  pointer: finding.pointer,
  occurrence: finding.occurrence ?? 0,
  kind: finding.kind,
  digest: finding.digest ?? null,
});

// Stable order so the written file diffs legibly between runs. The reader does
// not care about order; a human reviewing a prune does.
const sortEntries = (entries) =>
  [...entries].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.pointer.localeCompare(b.pointer) ||
      a.occurrence - b.occurrence,
  );

function tallyKinds(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([kind, count]) => `${count} ${kind}`)
    .join(', ');
}

// Computes what this run would change. Pure — the caller owns both the scan and
// the write.
//
// `missing` is every current finding absent from the baseline; `add` is that
// same set only when --accept-new was passed, which is the entire difference
// between the two modes. Two findings cannot share a key today (the checks that
// produce them are mutually exclusive), but first-wins dedupe keeps that an
// invariant of this file rather than an assumption about another one.
function planBaseline(findings, baseline, { acceptNew = false } = {}) {
  const current = new Map();
  for (const finding of findings) {
    const key = baselineKey(finding);
    if (!current.has(key)) current.set(key, entryFrom(finding));
  }

  const existingKeys = new Set(baseline.entries.map((entry) => baselineKey(entry)));
  const kept = baseline.entries.filter((entry) => current.has(baselineKey(entry)));
  const prune = baseline.entries.filter((entry) => !current.has(baselineKey(entry)));
  const missing = [...current.values()].filter((entry) => !existingKeys.has(baselineKey(entry)));
  const add = acceptNew ? missing : [];

  return {
    kept,
    prune,
    missing,
    add,
    entries: sortEntries([...kept, ...add]),
    changed: prune.length > 0 || add.length > 0,
  };
}

const describeEntry = (entry) =>
  `${entry.file}  ${entry.pointer}  #${entry.occurrence}  (${entry.kind ?? 'unknown'})`;

function printEntries(prefix, entries, limit = 25) {
  for (const entry of entries.slice(0, limit)) console.log(`  ${prefix} ${describeEntry(entry)}`);
  if (entries.length > limit) console.log(`  ${prefix} … and ${entries.length - limit} more`);
}

function serialize(entries) {
  return JSON.stringify({ version: 1, entries }, null, 2) + '\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`pointer-baseline: ${args.error}`);
    console.error('');
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const repoRoot = resolve(args.repoPath ?? process.cwd());
  const baselinePath = join(repoRoot, BASELINE_FILE);

  // useBaseline: false — the generator needs the UNSUPPRESSED findings. A
  // suppressed scan would report nothing for exactly the entries it has to
  // decide about.
  const findings = await scanPointerAnchors(repoRoot, { useBaseline: false });
  const baseline = await loadBaseline(repoRoot);

  console.log('## pointer-baseline');
  console.log('');
  console.log(`repo:     ${repoRoot}`);
  console.log(
    `baseline: ${BASELINE_FILE} — ${
      baseline.present ? `${baseline.entries.length} entries` : 'absent (nothing suppressed)'
    }`,
  );
  console.log(
    `scan:     ${findings.length} finding${findings.length === 1 ? '' : 's'}${
      findings.length > 0 ? ` (${tallyKinds(findings)})` : ''
    }`,
  );
  console.log(
    `mode:     ${args.acceptNew ? 'prune + accept-new' : 'prune-only'}, ${
      args.write ? 'write' : 'dry run'
    }`,
  );
  console.log('');

  // The refusal is checked BEFORE any plan is computed or printed, so a run
  // that cannot legitimately accept anything says only that.
  const blocking = findings.filter((finding) => BLOCKING_KINDS.includes(finding.kind));
  if (args.acceptNew && blocking.length > 0) {
    console.error(
      `REFUSED: --accept-new cannot run while ${blocking.length} finding${
        blocking.length === 1 ? '' : 's'
      } (${tallyKinds(blocking)}) show a pointer to be provably wrong.`,
    );
    console.error(
      'Baselining a known-wrong pointer would accept a citation the checker has already',
    );
    console.error('proved false. Repair these, then re-run:');
    console.error('');
    for (const finding of blocking) console.error(`  - ${finding.detail}`);
    console.error('');
    console.error('Nothing was written.');
    process.exit(1);
  }

  const plan = planBaseline(findings, baseline, { acceptNew: args.acceptNew });

  if (plan.prune.length > 0) {
    console.log(`### Prune — ${plan.prune.length} entry/entries match nothing in this scan`);
    printEntries('-', plan.prune);
    console.log('');
  }
  if (plan.add.length > 0) {
    console.log(`### Accept — ${plan.add.length} new entry/entries`);
    printEntries('+', plan.add);
    console.log('');
  }
  if (!args.acceptNew && plan.missing.length > 0) {
    console.log(
      `### ${plan.missing.length} finding${
        plan.missing.length === 1 ? ' is' : 's are'
      } not in the baseline — NOT added (prune-only)`,
    );
    console.log('  Re-run with --accept-new to accept them as debt.');
    console.log('');
  }

  console.log(
    `${plan.entries.length} entr${plan.entries.length === 1 ? 'y' : 'ies'} after this run ` +
      `(${plan.kept.length} kept, ${plan.add.length} added, ${plan.prune.length} pruned).`,
  );

  if (!plan.changed) {
    console.log('Nothing to change — the baseline file was not touched.');
    return;
  }
  if (!args.write) {
    console.log('Dry run — nothing written. Re-run with --write to apply.');
    return;
  }

  await fs.writeFile(baselinePath, serialize(plan.entries), 'utf8');
  console.log(`Wrote ${BASELINE_FILE}.`);
}

main().catch((err) => {
  console.error('pointer-baseline failed:', err);
  process.exit(1);
});
