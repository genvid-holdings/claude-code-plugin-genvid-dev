#!/usr/bin/env node
// Validates the consuming repo against the genvid plugin's convention
// contract. Walks installed skill/agent metadata.expects, evaluates each
// expectation against the cwd, and prints a structured report.
//
// Default mode is validate-only.
//   --fix         Compute the migration plan and print a dry-run summary.
//   --fix --apply Actually apply the plan to the filesystem.
//
// Exit code: 0 if all required expectations are satisfied (or --fix planning
// succeeded); 1 otherwise.

import { promises as fs } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { extractFrontmatter } from './lib/frontmatter.mjs';
import { descriptionLength, MAX_DESCRIPTION_CHARS } from './lib/description-length.mjs';
import { resolveKey } from './lib/config-resolve.mjs';
import { gitRemoteUrl } from './lib/git-info.mjs';
import {
  detectState,
  STATE_GREENFIELD,
  STATE_LEGACY,
  STATE_MIGRATED,
  STATE_STALE_CONFIG,
} from './lib/state-detect.mjs';
import { planGreenfield, planLegacy, planStaleConfig, planMigratedResync, hasC3Markers, applyPlan, scanDanglingReferences } from './lib/migrate.mjs';
import { detectHostDrift } from './lib/host-drift.mjs';
import { savePreviewedPlan, loadPreviewedPlan, clearPreviewedPlan, diffPlans, formatReconciliation } from './lib/reconcile.mjs';
import { scanRetiredTokens, scanBrokenLinks, scanOrphanedDocs, candidateFileCount } from './lib/hygiene.mjs';
import { resolveExpectationPath, overrideFindings, resolveDocsRoot } from './lib/path-overrides.mjs';
import { checkReadmeInventory } from './lib/readme-inventory.mjs';
import { scanPrincipleCitations } from './lib/principle-citations.mjs';
import { scanPointerAnchors } from './lib/pointer-anchors.mjs';
import { summarizeExpectations, formatScanSummary } from './lib/summary.mjs';
import { PILLARS, parsePillars } from './lib/pillars.mjs';
import { detectWikiAdoption } from './lib/practice-detect.mjs';
import { formatPracticeCoverage } from './lib/pillar-report.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, '..', '..', '..'); // <plugin>/skills/audit-conventions/scripts -> <plugin>

const REPO_ROOT = process.cwd();
const FIX_MODE = process.argv.includes('--fix');
const APPLY_MODE = process.argv.includes('--apply');

// True only when the plugin source being walked *is* inside the repo under
// audit — i.e. a maintainer/dogfood run on the plugin repo itself, not a
// consumer running the installed cache. Author-time lints (e.g. the
// description-length cap) are actionable only in that case; emitting them in a
// consumer's audit would be un-fixable noise about the plugin's own files.
const rel = relative(REPO_ROOT, PLUGIN_ROOT);
const AUDITING_PLUGIN_SOURCE = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));

// Report-local retired-token needles for the stale-config --fix Manual-follow-up scan.
// Deliberately NOT merged into DEFAULT_RETIRED_TOKENS (lib/hygiene.mjs) — keeping it
// scoped avoids newly flagging mid-migration / C3 repos in plain audit. Keep the
// 'genvid:'/'genvid-dev:' entries in sync with DEFAULT_RETIRED_TOKENS if that changes.
const STALE_REPORT_TOKENS = ['genvid:', 'genvid-dev:', '.genvid-agent.json'];

async function main() {
  const state = await detectState(REPO_ROOT);

  if (FIX_MODE) {
    await runFix(state);
    return;
  }

  // A stale-named legacy config (.genvid-agent.json) carries the same schema
  // as .gvt-agent.json (issue #117/#118) — evaluate expectations against it
  // under its actual filename so the report shows its keys as satisfied
  // instead of flooding on a config file that (correctly) doesn't exist yet.
  let configFilename = '.gvt-agent.json';
  let cfgHasC3 = false;
  if (state === STATE_STALE_CONFIG) {
    configFilename = '.genvid-agent.json';
    try {
      const cfg = JSON.parse(await fs.readFile(join(REPO_ROOT, configFilename), 'utf8'));
      cfgHasC3 = hasC3Markers(cfg);
    } catch {
      // unreadable/invalid JSON — leave cfgHasC3 false; evaluateConfig below
      // will surface the read failure per-expectation.
    }
  }

  const components = await walkComponents(PLUGIN_ROOT);

  // Loaded here — before the expectation loop — because evaluateFile /
  // evaluateConfig below need `paths` to resolve overrides as they walk each
  // component's declared expectations. Reused (not reloaded) at the Practice
  // Coverage read further down.
  const repoConfig = await loadRepoConfig(configFilename);
  const pathOverrides = repoConfig?.paths;
  const { root: docsRoot, unrepresentable: docsRootUnrepresentable } = resolveDocsRoot(pathOverrides);

  const findings = [];
  const declaredPaths = new Set();
  for (const component of components) {
    const expects = component.expects;
    if (!expects) continue;

    for (const entry of expects.files ?? []) {
      declaredPaths.add(entry.path);
      findings.push(await evaluateFile(component, entry, pathOverrides));
    }
    for (const entry of expects.config ?? []) {
      findings.push(await evaluateConfig(component, entry, configFilename, pathOverrides));
    }
    for (const entry of expects.tools ?? []) {
      findings.push(evaluateTool(component, entry));
    }
  }
  // Surfaces a `paths` key that doesn't match any declared expectation path
  // (typo, retired path) or an unusable override value — otherwise a mistyped
  // key is silently inert, which is the defect this wiring exists to fix.
  findings.push(...overrideFindings(pathOverrides, declaredPaths));

  const hostDrift = await evaluateHostDrift(configFilename);
  if (hostDrift) findings.push(hostDrift);

  const conventionsDrift = await evaluateConventionsDrift(state, PLUGIN_ROOT);
  if (conventionsDrift) findings.push(conventionsDrift);

  for (const finding of evaluateDescriptionLengths(components)) findings.push(finding);
  for (const finding of evaluatePillarDeclarations(components)) findings.push(finding);

  // Author-time lint (maintainer/dogfood run only): the repo-root README's
  // Skills table / Agents list must stay in sync with plugin/skills + plugin/agents.
  if (AUDITING_PLUGIN_SOURCE) {
    const readme = await readFileOrNull(join(REPO_ROOT, 'README.md'));
    const skillNames = components.filter((c) => c.type === 'skill').map((c) => c.name);
    const agentNames = components.filter((c) => c.type === 'agent').map((c) => c.name);
    findings.push(...checkReadmeInventory(readme, skillNames, agentNames));

    // Also author-time-only, but `error` rather than the family's usual
    // `warning`: a consumer can't fix the plugin's own principle citations
    // (the check is confined to this repo's `plugin/` tree, so it can only
    // ever break this repo's own build, never a consumer's), and a
    // mis-pointed citation silently repoints agent guidance at the wrong
    // principle — a functional regression, not a doc-tidiness gap.
    findings.push(...(await scanPrincipleCitations(REPO_ROOT)));

    // Also `error`, but the gate carries a DIFFERENT weight here — do not read
    // the argument above as covering this call too. The principle-citation
    // scanner is confined to this repo's `plugin/` tree, so it is inherently
    // un-runnable against a consumer; this scanner's citing corpus reaches the
    // repo-root `docs/` tree, including `docs/decisions/` — a directory
    // consuming repos also have, because `create-adr` scaffolds it. Run
    // ungated, this check would impose the content-anchor convention on every
    // consumer's ADRs and fail their `commands.validate` over prose the plugin
    // does not own.
    //
    // What makes `error` safe is therefore the gate itself, not the scanner's
    // reach: AUDITING_PLUGIN_SOURCE is derived from the AUDITED repo (`relative(
    // REPO_ROOT, PLUGIN_ROOT)` above), so inside this block "repo-root
    // `docs/decisions/`" can only ever mean *this* repo's own ADRs. Move this
    // call outside the block and the severity stops being defensible.
    findings.push(...(await scanPointerAnchors(REPO_ROOT)));
  }

  const hygiene = await loadHygieneConfig(configFilename);
  // wikiDir/rawDir come from repoConfig's `wiki` block (already loaded above
  // for wikiAdoption), not the `hygiene` block — same shared hygieneOpts
  // object passed to all three scanners below, but only scanRetiredTokens
  // reads wikiDir (see its call site in lib/hygiene.mjs); rawDir folds into
  // effectiveExcludes for whichever scanners it's nested inside.
  const hygieneOpts = {
    retiredTokens: hygiene?.retiredTokens,
    excludePaths: hygiene?.excludePaths,
    docsRoot,
    wikiDir: repoConfig?.wiki?.wikiDir,
    rawDir: repoConfig?.wiki?.rawDir,
  };
  findings.push(...(await scanRetiredTokens(REPO_ROOT, hygieneOpts)));
  findings.push(...(await scanBrokenLinks(REPO_ROOT, hygieneOpts)));
  findings.push(...(await scanOrphanedDocs(REPO_ROOT, hygieneOpts)));

  // Report-only figure for the Summary line below — NOT pushed into
  // `findings` (that would render as a 13th Info bullet on this repo and
  // desync the pinned bullet-count acceptance check). See formatScanSummary
  // (lib/summary.mjs): it distinguishes "scanned N files and found nothing"
  // from "found nothing because there was nothing to scan" — the exact
  // false-green #384 reports for a relocated docs root.
  const scanSummary = {
    root: [`${docsRoot}/`, 'CLAUDE.md'],
    unrepresentable: docsRootUnrepresentable,
    fileCount: await candidateFileCount(REPO_ROOT, hygieneOpts),
  };

  // Practice Coverage (epic #142): the plugin-side census is the same
  // `components` walk used for expectations above (each entry already
  // carries its parsed `pillar` field); the consumer-side adoption verdict
  // is currently wired for the `environment` pillar only (the wiki — the
  // only pillar with a detector today, per lib/practice-detect.mjs).
  const wikiAdoption = await detectWikiAdoption(REPO_ROOT, repoConfig);
  const practices = { environment: wikiAdoption.verdict };

  const report = formatReport(state, findings, { cfgHasC3, pillarCensus: components, practices, scanSummary });
  console.log(report);

  const hasErrors = findings.some((f) => f.severity === 'error');
  process.exit(hasErrors ? 1 : 0);
}

// ---- walk ------------------------------------------------------------------

async function walkComponents(pluginRoot) {
  const components = [];

  const skillsDir = join(pluginRoot, 'skills');
  if (await dirExists(skillsDir)) {
    const skills = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of skills) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(skillsDir, entry.name, 'SKILL.md');
      if (!(await fileExists(skillFile))) continue;
      const component = await loadComponent('skill', entry.name, skillFile);
      if (component) components.push(component);
    }
  }

  const agentsDir = join(pluginRoot, 'agents');
  if (await dirExists(agentsDir)) {
    const agents = await fs.readdir(agentsDir, { withFileTypes: true });
    for (const entry of agents) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const name = entry.name.replace(/\.md$/, '');
      const component = await loadComponent('agent', name, join(agentsDir, entry.name));
      if (component) components.push(component);
    }
  }

  return components;
}

async function loadComponent(type, name, filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  const descLen = descriptionLength(content);
  const fm = extractFrontmatter(content);
  if (!fm) return { type, name, expects: null, descLen, pillar: [] };
  return {
    type,
    name,
    expects: fm.metadata?.expects ?? null,
    descLen,
    pillar: parsePillars(fm.metadata?.pillar),
  };
}

// ---- evaluate --------------------------------------------------------------

// A trailing slash in the declared `path` marks a DIRECTORY expectation (e.g.
// `docs/decisions/`, declared by create-adr, plan-task, and tech-writer).
// fileExists() is isFile()-strict, so checking a directory through it always
// reported "file not found" no matter what was on disk — telling a repo that
// HAD scaffolded docs/decisions/ that it hadn't, and (had any directory
// expectation ever been marked required) failing the audit outright.
async function evaluateFile(component, entry, pathOverrides) {
  const required = entry.required !== false;
  const resolvedPath = resolveExpectationPath(pathOverrides, entry.path);
  const path = join(REPO_ROOT, resolvedPath);
  const isDir = resolvedPath.endsWith('/');
  const exists = isDir ? await dirExists(path) : await fileExists(path);

  if (exists) {
    return { kind: 'file', component: component.name, target: entry.path, ok: true, required };
  }
  return {
    kind: 'file',
    component: component.name,
    target: entry.path,
    ok: false,
    required,
    severity: required ? 'error' : 'info',
    detail: `${isDir ? 'directory' : 'file'} not found${required ? '' : ' (optional)'}`,
    reason: entry.reason,
  };
}

async function evaluateConfig(component, entry, configFilename = '.gvt-agent.json', pathOverrides) {
  const required = entry.required !== false;
  const inFile = resolveExpectationPath(pathOverrides, entry.in ?? configFilename);
  const filePath = join(REPO_ROOT, inFile);

  let parsed;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: 'config',
      component: component.name,
      target: `${entry.key} in ${inFile}`,
      ok: false,
      required,
      severity: required ? 'error' : 'info',
      detail: err.code === 'ENOENT' ? `${inFile} not found` : `${inFile} unreadable (${err.message})`,
      reason: entry.reason,
    };
  }

  const result = resolveKey(parsed, entry.key);
  if (result.found) {
    return {
      kind: 'config',
      component: component.name,
      target: `${entry.key} in ${inFile}`,
      ok: true,
      required,
    };
  }
  return {
    kind: 'config',
    component: component.name,
    target: `${entry.key} in ${inFile}`,
    ok: false,
    required,
    severity: required ? 'error' : 'info',
    detail: `key not found (path broke at "${result.missingAt}")${required ? '' : ' (optional)'}`,
    reason: entry.reason,
  };
}

function evaluateTool(component, entry) {
  const required = entry.required !== false;
  const exists = commandExists(entry.command);

  if (exists) {
    return { kind: 'tool', component: component.name, target: entry.command, ok: true, required };
  }
  return {
    kind: 'tool',
    component: component.name,
    target: entry.command,
    ok: false,
    required,
    severity: required ? 'error' : 'info',
    detail: `command not found on PATH${required ? '' : ' (optional)'}`,
    reason: entry.reason,
  };
}

// Cross-checks .gvt-agent.json `repo.host` against the actual git remote and
// returns a non-fatal warning finding on mismatch (or null when there's nothing
// to flag). This is a repo-health check, not a per-component expectation — a
// stale host misleads host-specific skills (create-pr, release-*) at the start
// of a session, and repos do migrate hosts (Bitbucket → GitHub).
async function evaluateHostDrift(configFilename = '.gvt-agent.json') {
  let configuredHost;
  try {
    const raw = await fs.readFile(join(REPO_ROOT, configFilename), 'utf8');
    configuredHost = resolveKey(JSON.parse(raw), 'repo.host').value;
  } catch {
    return null; // no config / unreadable — other findings cover that
  }

  const drift = detectHostDrift({ configuredHost, remoteUrl: gitRemoteUrl(REPO_ROOT) });
  if (!drift) return null;

  return {
    kind: 'host-drift',
    ok: false,
    severity: 'warning',
    detail:
      `\`repo.host\` is \`${drift.configured}\` but the \`origin\` remote is a ` +
      `${drift.inferred} URL — set \`repo.host\` to \`${drift.inferred}\` in ` +
      `.gvt-agent.json (or update the remote).`,
  };
}

// Compares the repo-root CONVENTIONS.md against the plugin's canonical copy
// and flags drift (non-fatal — a repo-health check, not a per-component
// expectation). Only meaningful once a repo has actually migrated: a
// greenfield/legacy/stale-config repo either has no CONVENTIONS.md yet or is
// mid-migration, so drift there is covered by other findings instead. Absence
// of a repo-root CONVENTIONS.md is itself NOT flagged — this very repo has no
// root CONVENTIONS.md (only plugin/CONVENTIONS.md), and flagging it would make
// this repo's own dogfood `commands.validate` permanently noisy.
async function evaluateConventionsDrift(state, pluginRoot) {
  if (state !== STATE_MIGRATED && state !== STATE_STALE_CONFIG) return null;

  let repoContent;
  try {
    repoContent = await fs.readFile(join(REPO_ROOT, 'CONVENTIONS.md'), 'utf8');
  } catch {
    return null; // no root CONVENTIONS.md — nothing to compare, stay silent
  }

  const canonicalContent = await fs.readFile(join(pluginRoot, 'CONVENTIONS.md'), 'utf8');
  if (repoContent === canonicalContent) return null;

  return {
    kind: 'conventions-drift',
    ok: false,
    severity: 'warning',
    detail:
      "CONVENTIONS.md has drifted from the plugin's canonical copy — run " +
      '`/gvt-dev:audit-conventions --fix` to preview the resync.',
  };
}

// Author-time lint: flag any skill/agent whose rendered description exceeds the
// session listing's `skillListingMaxDescChars` cap, since over-cap descriptions
// are silently truncated in the listing. Non-fatal warnings (repo-health, not a
// contract expectation), and only in a maintainer run against the plugin source
// — a consumer can't fix the plugin's own descriptions.
function evaluateDescriptionLengths(components) {
  if (!AUDITING_PLUGIN_SOURCE) return [];
  const findings = [];
  for (const c of components) {
    if (c.descLen > MAX_DESCRIPTION_CHARS) {
      findings.push({
        kind: 'desc-length',
        ok: false,
        severity: 'warning',
        detail:
          `${c.type} \`${c.name}\` description is ${c.descLen} chars, over the ` +
          `${MAX_DESCRIPTION_CHARS}-char \`skillListingMaxDescChars\` cap — it is ` +
          `silently truncated in the skill listing. Trim it.`,
      });
    }
  }
  return findings;
}

// Author-time lint: flag any skill/agent whose `metadata.pillar` names an id
// not in PILLARS (e.g. a typo like `enviroment`). Non-fatal warning, and only
// in a maintainer/dogfood run against the plugin source — a consumer's audit
// walks the installed cache, whose pillar declarations a consumer can't fix.
function evaluatePillarDeclarations(components) {
  if (!AUDITING_PLUGIN_SOURCE) return [];
  const validIds = new Set(PILLARS.map((p) => p.id));
  const findings = [];
  for (const c of components) {
    for (const id of c.pillar ?? []) {
      if (validIds.has(id)) continue;
      findings.push({
        kind: 'pillar-unknown',
        ok: false,
        severity: 'warning',
        detail:
          `${c.type} \`${c.name}\` declares unknown pillar \`${id}\` — expected one of: ` +
          `${[...validIds].join(', ')}.`,
      });
    }
  }
  return findings;
}

// Reads the full parsed config file (graceful — missing/unreadable/invalid
// JSON all resolve to undefined). Used for cross-cutting reads (e.g. the
// `wiki` block feeding Practice Coverage's Environment adoption verdict)
// that aren't a per-component expectation.
async function loadRepoConfig(configFilename = '.gvt-agent.json') {
  try {
    const raw = await fs.readFile(join(REPO_ROOT, configFilename), 'utf8');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Reads the optional `hygiene` block from the repo's config file (graceful —
// missing file, missing key, or invalid JSON all resolve to undefined so the
// hygiene scanners fall back to their own baked-in defaults). Not merged with
// the per-component config reads above since this is a repo-health check, not
// a component expectation.
async function loadHygieneConfig(configFilename = '.gvt-agent.json') {
  try {
    const raw = await fs.readFile(join(REPO_ROOT, configFilename), 'utf8');
    return JSON.parse(raw).hygiene;
  } catch {
    return undefined;
  }
}

// ---- helpers ---------------------------------------------------------------

async function fileExists(path) {
  try {
    const s = await fs.stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function dirExists(path) {
  try {
    const s = await fs.stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function readFileOrNull(path) {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function commandExists(cmd) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [cmd], { stdio: 'pipe' });
  return result.status === 0;
}

// ---- report ----------------------------------------------------------------

function formatReport(state, findings, { cfgHasC3 = false, pillarCensus = [], practices = {}, scanSummary = null } = {}) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const infos = findings.filter((f) => f.severity === 'info');

  const lines = [];
  lines.push('## Audit Results');
  lines.push('');
  lines.push(`State: ${state}`);
  lines.push('');

  if (errors.length > 0) {
    lines.push('### Errors (must fix)');
    for (const f of errors) lines.push(formatFinding(f));
    lines.push('');
  }
  if (warnings.length > 0) {
    lines.push('### Warnings');
    for (const f of warnings) lines.push(formatFinding(f));
    lines.push('');
  }
  if (infos.length > 0) {
    lines.push('### Info (optional)');
    for (const f of infos) lines.push(formatFinding(f));
    lines.push('');
  }

  const coverage = formatPracticeCoverage(pillarCensus, practices);
  if (coverage) {
    lines.push(coverage);
    lines.push('');
  }

  const { requiredMet, requiredTotal, optionalMet, optionalTotal } = summarizeExpectations(findings);
  lines.push('### Summary');
  lines.push(`- required: ${requiredMet} of ${requiredTotal} satisfied.`);
  lines.push(`- optional: ${optionalMet} of ${optionalTotal} satisfied.`);
  if (scanSummary) {
    lines.push(`- ${formatScanSummary(scanSummary)}`);
  }
  if (errors.length > 0) {
    lines.push(`- ${errors.length} required expectation${errors.length === 1 ? '' : 's'} unmet.`);
  }
  if (warnings.length > 0) {
    lines.push(`- ${warnings.length} warning${warnings.length === 1 ? '' : 's'} (non-fatal).`);
  }
  if (infos.length > 0) {
    lines.push(`- ${infos.length} optional expectation${infos.length === 1 ? '' : 's'} unmet.`);
  }
  if (state === STATE_LEGACY) {
    lines.push('');
    lines.push('> Run `--fix` to migrate from the legacy template-rendered setup.');
  } else if (state === STATE_GREENFIELD) {
    lines.push('');
    lines.push('> Run `--fix` to scaffold the four convention files.');
  } else if (state === STATE_STALE_CONFIG) {
    lines.push('');
    if (cfgHasC3) {
      lines.push(
        '> Legacy `.genvid-agent.json` with C3 markers detected. Run `--fix` to see the '
        + 'port-and-keep steps (it will NOT auto-rename).',
      );
    } else {
      lines.push('> Legacy `.genvid-agent.json` detected (pre-`gvt` name). Run `--fix` to rename it to `.gvt-agent.json`.');
    }
  }

  return lines.join('\n');
}

function formatFinding(f) {
  // Repo-health / author-lint findings (host-drift, conventions-drift,
  // desc-length, the hygiene scanners' retired-token/broken-link/
  // orphaned-doc, readme-inventory, principle-citation, and path-override)
  // aren't tied to a component/expectation — they carry a self-contained
  // detail string.
  const SELF_CONTAINED_KINDS = [
    'host-drift',
    'conventions-drift',
    'desc-length',
    'retired-token',
    'broken-link',
    'orphaned-doc',
    'readme-inventory',
    'principle-citation',
    'pillar-unknown',
    'path-override',
  ];
  // The pointer-anchor scanner is matched by PREFIX rather than enumerated: it
  // emits eight kinds that all share the `pointer-` prefix, all self-contained,
  // and the set grows with the ratchet. Without this the pointer findings
  // render through the component branch below with `f.component` undefined.
  if (SELF_CONTAINED_KINDS.includes(f.kind) || f.kind.startsWith('pointer-')) return `- ${f.detail}`;
  const reason = f.reason ? ` Reason: ${f.reason}` : '';
  return `- **${f.component}** expects ${f.kind === 'tool' ? `tool \`${f.target}\`` : `\`${f.target}\``} — ${f.detail}.${reason}`;
}

// ---- --fix orchestration ---------------------------------------------------

// Scans for the stale-report retired-token needles (see STALE_REPORT_TOKENS
// above) and reduces the hits to CLAUDE.md / <docsRoot>/ files only, in the
// same { file, hint } shape formatDanglingReport expects. Report-only — no
// rewriting. docsRoot defaults to 'docs' (a repo with no `paths` override
// behaves byte-identically); callers resolve it via resolveDocsRoot before
// calling, same as main()'s hygieneOpts.
async function staleFollowup(docsRoot = 'docs') {
  const hits = await scanRetiredTokens(REPO_ROOT, { retiredTokens: STALE_REPORT_TOKENS, docsRoot });
  return hits
    .filter((h) => h.file === 'CLAUDE.md' || h.file.startsWith(`${docsRoot}/`))
    .map((h) => ({ file: h.file, hint: `line ${h.line} uses retired token '${h.token}'` }));
}

async function runFix(state) {
  // Mirrors main()'s STATE_STALE_CONFIG config-filename handling (a stale
  // `.genvid-agent.json` carries the same schema as `.gvt-agent.json`) so a
  // `paths` override in that legacy file is honored by staleFollowup below,
  // the same as it would be in a plain audit run.
  const fixConfigFilename = state === STATE_STALE_CONFIG ? '.genvid-agent.json' : '.gvt-agent.json';
  const fixRepoConfig = await loadRepoConfig(fixConfigFilename);
  const { root: fixDocsRoot } = resolveDocsRoot(fixRepoConfig?.paths);

  if (APPLY_MODE && !(await workingTreeClean())) {
    console.error('## --fix --apply\n');
    console.error(`State: ${state}\n`);
    console.error('Refusing to apply with a dirty working tree. Commit or stash your changes first,');
    console.error('so the migration lands as a reviewable diff with nothing else mixed in.');
    console.error('(The --fix dry-run writes nothing to your repo and runs fine on a dirty tree — preview there first.)');
    process.exit(1);
  }

  let plan;
  if (state === STATE_GREENFIELD) {
    plan = await planGreenfield(REPO_ROOT, PLUGIN_ROOT);
  } else if (state === STATE_STALE_CONFIG) {
    plan = await planStaleConfig(REPO_ROOT, PLUGIN_ROOT);
  } else if (state === STATE_MIGRATED) {
    plan = await planMigratedResync(REPO_ROOT, PLUGIN_ROOT);
  } else {
    // STATE_LEGACY
    const snapshotPath = join(SCRIPT_DIR, 'legacy-manifest-snapshot.json');
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
    plan = await planLegacy(REPO_ROOT, PLUGIN_ROOT, snapshot);
  }

  if (!APPLY_MODE) {
    console.log(formatPlanDryRun(plan));
    if (state === STATE_STALE_CONFIG) console.log('\n' + formatDanglingReport(await staleFollowup(fixDocsRoot)));
    savePreviewedPlan(REPO_ROOT, plan);
    process.exit(0);
  }

  console.log(`## --fix --apply (state: ${plan.state})\n`);
  const previewed = loadPreviewedPlan(REPO_ROOT);
  const results = await applyPlan(plan, REPO_ROOT);
  console.log(formatApplyResults(results));

  if (previewed !== null) {
    const diff = diffPlans(previewed, plan);
    const reconLine = formatReconciliation(
      diff,
      previewed.actions.length,
      previewed.actions.length - diff.dropped.length,
    );
    if (reconLine) console.log('\n' + reconLine);
  } else {
    console.log('\nNo previewed plan found to reconcile against — run --fix first to preview, then --fix --apply.');
  }

  // Surface anything the plan could not clean up automatically (stale doc/text
  // references, orphaned sidecars) so the user has an explicit follow-up list.
  if (plan.state === STATE_LEGACY) {
    const warnings = await scanDanglingReferences(REPO_ROOT);
    console.log('\n' + formatDanglingReport(warnings));
  }
  if (plan.state === STATE_STALE_CONFIG) {
    console.log('\n' + formatDanglingReport(await staleFollowup(fixDocsRoot)));
  }

  clearPreviewedPlan(REPO_ROOT);

  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length > 0 ? 1 : 0);
}

async function workingTreeClean() {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    // Not a git repo, or git unavailable — let the operation proceed but warn.
    return true;
  }
  return result.stdout.trim() === '';
}

function formatPlanDryRun(plan) {
  const lines = ['## --fix dry-run'];
  lines.push('');
  lines.push(`State: ${plan.state}`);
  lines.push('');
  lines.push(`The following ${plan.actions.length} action${plan.actions.length === 1 ? '' : 's'} would be applied:`);
  lines.push('');
  let i = 1;
  for (const action of plan.actions) {
    lines.push(`${i}. ${action.summary}`);
    i++;
  }
  lines.push('');
  lines.push('Re-run with `--fix --apply` to actually apply these changes.');
  lines.push('No changes have been written to your repo.');
  return lines.join('\n');
}

function formatApplyResults(results) {
  const lines = [];
  for (const r of results) {
    const prefix = r.ok ? '✓' : '✗';
    lines.push(`${prefix} ${r.summary}${r.error ? ` — ${r.error}` : ''}`);
  }
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  lines.push('');
  lines.push(`Applied ${ok}/${results.length} actions${failed > 0 ? ` (${failed} failed)` : ''}.`);
  lines.push('');
  lines.push('Review the changes with `git status` / `git diff` and commit when ready.');
  return lines.join('\n');
}

function formatDanglingReport(warnings) {
  const lines = ['### Manual follow-up'];
  lines.push('');
  if (warnings.length === 0) {
    lines.push('No dangling references detected. Nothing left to clean up by hand.');
    return lines.join('\n');
  }
  lines.push('The migration could not clean these up automatically — review and fix by hand:');
  lines.push('');
  for (const w of warnings) {
    lines.push(`- \`${w.file}\` — ${w.hint}.`);
  }
  return lines.join('\n');
}

main().catch((err) => {
  // Apply can throw after the dry-run persisted a plan (e.g. applyPlan or
  // scanDanglingReferences fails) — drop the snapshot so it never lingers in
  // tmpdir or gets reconciled against by a later --apply. No-op when absent.
  clearPreviewedPlan(REPO_ROOT);
  console.error('audit failed:', err);
  process.exit(2);
});
