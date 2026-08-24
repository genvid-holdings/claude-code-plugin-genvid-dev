// Pure repo-hygiene scanners for audit-conventions.
//
// Each scanner is `(repoRoot, opts = {}) => findings[]` (async, pure — no fs
// writes). Findings follow the same self-contained shape as audit.mjs's other
// repo-health checks (host-drift, conventions-drift, desc-length): `{ kind,
// ok: false, severity, detail }`, no `component`/`target`/`reason` fields since
// these aren't tied to a component's metadata.expects declaration.
//
// Wired into audit.mjs's validate mode (main()) as info/warning findings.

import { promises as fs } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

import { listMarkdown } from './fs-walk.mjs';
import { gitTrackedFiles } from './git-info.mjs';
import { iterateUnfencedLines, maskInlineCode } from './md-scan.mjs';

export const DEFAULT_RETIRED_TOKENS = ['genvid:', 'genvid-dev:', 'genvid-c3'];
export const DEFAULT_EXCLUDE_PATHS = ['CHANGELOG.md', 'docs/superpowers/', 'docs/decisions/'];

// Fixed allow-list of repo-root config paths scanRetiredTokens also considers,
// beyond the Markdown candidate set. Repo-relative, forward-slash paths. Not
// scanned by presence alone — see configCandidateFiles below, which
// intersects this list with `git ls-files` (ADR-0014): a per-developer
// .claude/settings.local.json is conventionally untracked and can
// legitimately contain a literal retired-token string (e.g. a permission
// grep-pattern rule), so scanning it by presence would false-positive on
// local junk.
export const RETIRED_TOKEN_CONFIG_CANDIDATES = [
  'package.json',
  '.gvt-agent.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
];

// Inline code spans and fenced code blocks are skipped — scanBrokenLinks below
// reads its lines through md-scan.mjs's iterateUnfencedLines (which suppresses
// fenced blocks and their delimiter lines) and masks each one with that
// module's maskInlineCode — so a doc showing `[text](fake.md)` as a Markdown
// example no longer false-positives. Known remaining limitation:
// reference-style links (`[text][ref]`) are not resolved — intentionally out
// of scope (#135).
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

// ---- shared helpers ---------------------------------------------------------

function isExcluded(relPath, excludePaths) {
  return excludePaths.some((entry) => relPath.startsWith(entry) || relPath.includes(entry));
}

// Resolved, anchored exclude entry for opts.rawDir (ADR-0015 decision 1's
// `raw/` exemption), but ONLY when rawDir is actually nested inside one of
// the walked roots (opts.docsRoot, defaulting to 'docs', or opts.wikiDir).
// The default repo-root layout (rawDir: 'raw') is already outside every
// walked root, so this returns [] for it — nothing to fold in, matching
// ADR-0015 decision 1 unamended. The nested layout (e.g. rawDir:
// 'docs/raw') IS inside the docs walk, so its resolved, anchored path is
// added. CRITICAL: never fold in the bare directory name — isExcluded below
// matches by `startsWith` OR `includes` (a substring test), so a bare
// 'raw/' would also match 'docs/draw/' and any other path containing that
// substring. Anchoring on the full resolved path (with a trailing slash)
// avoids that trap.
function rawDirExclude(opts) {
  const rawDir = opts.rawDir;
  if (!rawDir) return [];
  const docsRoot = opts.docsRoot ?? 'docs';
  const roots = [docsRoot, opts.wikiDir].filter(Boolean);
  const withinWalkedRoot = roots.some((root) => rawDir === root || rawDir.startsWith(`${root}/`));
  return withinWalkedRoot ? [`${rawDir}/`] : [];
}

// Effective exclude-path set for a given opts: a UNION of the baked-in
// defaults, any opts.excludePaths, and the conditional rawDir guard above
// (see the union-vs-replace note on listCandidateFiles below). Shared by
// listCandidateFiles, configCandidateFiles, and wikiCandidateFiles so every
// scanner's notion of "excluded" stays in sync.
function effectiveExcludes(opts) {
  return [...DEFAULT_EXCLUDE_PATHS, ...(opts.excludePaths ?? []), ...rawDirExclude(opts)];
}

// Candidate file set shared by all three scanners: <docsRoot>/**.md + repo-root
// CLAUDE.md, minus excludePaths. Repo-relative, forward-slash paths (matches
// listMarkdown's shape). Missing <docsRoot>/ or CLAUDE.md are handled gracefully
// by listMarkdown / safeReadFile respectively — this helper never throws.
//
// opts.docsRoot relocates the walk root away from the 'docs' default — see
// resolveDocsRoot (lib/path-overrides.mjs), which derives it from a
// `docs/TOC.md` paths override and already guards the unrepresentable case
// (a repo-root override would make this walk recurse the entire repo). A
// repo with no override behaves byte-identically: opts.docsRoot is undefined
// and the default 'docs' applies.
//
// excludePaths is a UNION of the baked-in defaults and any opts.excludePaths
// — the defaults (CHANGELOG.md, docs/superpowers/, docs/decisions/) always
// apply, so a consuming repo customizing this list only needs to name what it
// wants to ADD, not restate the defaults. This differs from retiredTokens
// (below), which replaces-when-provided, since a repo's deny-list is a
// deliberate full override.
async function listCandidateFiles(repoRoot, opts = {}) {
  const docsRoot = opts.docsRoot ?? 'docs';
  const excludePaths = effectiveExcludes(opts);
  const files = [...(await listMarkdown(repoRoot, docsRoot)), 'CLAUDE.md'];
  return files.filter((f) => !isExcluded(f, excludePaths));
}

// Count-only wrapper around listCandidateFiles, for callers (audit.mjs's
// Summary line) that need "how many files did the walk cover" without
// re-implementing the walk. Same opts, same graceful missing-dir handling.
export async function candidateFileCount(repoRoot, opts = {}) {
  return (await listCandidateFiles(repoRoot, opts)).length;
}

// Candidate file set for a repo's wiki checkout: *.md under <wikiDir>/,
// repo-relative forward-slash paths (matches listMarkdown's shape), minus
// excludePaths. A falsy/absent wikiDir returns [] rather than walking the
// repo root — a repo with no wiki must get an empty set, never a scan of
// repoRoot itself. A wikiDir naming a directory that doesn't exist on disk
// also returns [] (listMarkdown's readdir failure is caught and swallowed,
// same as a missing docs/). Called by scanRetiredTokens ONLY (ADR-0041,
// ADR-0015 decision 2: scanBrokenLinks and scanOrphanedDocs deliberately
// never see wiki files — see the call site below for why the token scan is
// the one exception).
export async function wikiCandidateFiles(repoRoot, wikiDir, opts = {}) {
  if (!wikiDir) return [];
  const excludePaths = effectiveExcludes(opts);
  const files = await listMarkdown(repoRoot, wikiDir);
  return files.filter((f) => !isExcluded(f, excludePaths));
}

async function safeReadFile(path) {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function pathExists(path) {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

// Config candidate set for scanRetiredTokens only: RETIRED_TOKEN_CONFIG_CANDIDATES
// intersected with the git-tracked set, minus excludePaths (same union
// semantics as listCandidateFiles). If gitTrackedFiles returns null (not a
// git repo, or git unavailable), the config scan is skipped ([]) — the
// Markdown scan is unaffected. See ADR-0014.
function configCandidateFiles(repoRoot, opts = {}) {
  const excludePaths = effectiveExcludes(opts);
  const tracked = gitTrackedFiles(repoRoot);
  if (tracked == null) return [];
  return RETIRED_TOKEN_CONFIG_CANDIDATES.filter(
    (f) => tracked.has(f) && !isExcluded(f, excludePaths),
  );
}

// ---- scanRetiredTokens -------------------------------------------------------

export async function scanRetiredTokens(repoRoot, opts = {}) {
  const retiredTokens = opts.retiredTokens ?? DEFAULT_RETIRED_TOKENS;
  // scanRetiredTokens is the ONLY scanner that also walks opts.wikiDir
  // (ADR-0015 decision 2 / ADR-0041). scanBrokenLinks and scanOrphanedDocs
  // deliberately never see wiki files: `maintain-wiki`'s own `lint` verb
  // already owns dead-wiki-links and orphaned-page checks for `<wikiDir>/`,
  // resolving OKF §6.1 bundle-absolute targets (`/page.md`) against
  // `<wikiDir>/` itself — a second, differently-rooted link/orphan
  // implementation here would just be wrong (plugin/skills/maintain-wiki/
  // SKILL.md:265-273: "not wired into audit.mjs and must not be"). The token
  // scan has no such owner: `lint` has no retired-token check at all (`grep
  // -i token` over maintain-wiki/SKILL.md returns nothing), so token drift on
  // the wiki tier is genuinely unowned unless this scanner reaches it.
  const files = [
    ...(await listCandidateFiles(repoRoot, opts)),
    ...(await wikiCandidateFiles(repoRoot, opts.wikiDir, opts)),
    ...configCandidateFiles(repoRoot, opts),
  ];
  const findings = [];

  for (const relPath of files) {
    const content = await safeReadFile(join(repoRoot, relPath));
    if (content == null) continue;

    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes('http')) return; // provenance/issue URLs are correct-as-history
      for (const token of retiredTokens) {
        if (line.includes(token)) {
          findings.push({
            kind: 'retired-token',
            ok: false,
            severity: 'info',
            detail: `${relPath}:${idx + 1} contains retired token '${token}'`,
            file: relPath,
            line: idx + 1,
            token,
          });
        }
      }
    });
  }

  return findings;
}

// ---- scanBrokenLinks ---------------------------------------------------------

export async function scanBrokenLinks(repoRoot, opts = {}) {
  const files = await listCandidateFiles(repoRoot, opts);
  const findings = [];

  for (const relPath of files) {
    const content = await safeReadFile(join(repoRoot, relPath));
    if (content == null) continue;

    for (const { lineNumber, text } of iterateUnfencedLines(content)) {
      const maskedLine = maskInlineCode(text);
      LINK_RE.lastIndex = 0;
      let match;
      while ((match = LINK_RE.exec(maskedLine))) {
        const rawTarget = match[1].trim();
        if (!rawTarget) continue;
        if (rawTarget.startsWith('#')) continue; // pure anchor
        if (/^https?:/i.test(rawTarget) || /^mailto:/i.test(rawTarget)) continue; // external

        const strippedTarget = rawTarget.split('#')[0].trim(); // drop trailing #anchor
        if (!strippedTarget) continue; // was e.g. "./file.md#anchor" with nothing left — shouldn't happen, but be safe

        const containingDir = dirname(join(repoRoot, relPath));
        const absTarget = strippedTarget.startsWith('/')
          ? join(repoRoot, strippedTarget.slice(1))
          : resolve(containingDir, strippedTarget);

        // fs.stat (not a file-only check) — directory targets (plugin/skeleton/,
        // examples/, audit-conventions-evals/) are valid and must not be flagged.
        const exists = await pathExists(absTarget);
        if (!exists) {
          findings.push({
            kind: 'broken-link',
            ok: false,
            severity: 'warning',
            detail: `${relPath}:${lineNumber} broken link -> ${rawTarget}`,
          });
        }
      }
    }
  }

  return findings;
}

// ---- scanOrphanedDocs ---------------------------------------------------------

export async function scanOrphanedDocs(repoRoot, opts = {}) {
  const docsRoot = opts.docsRoot ?? 'docs';
  const tocPath = `${docsRoot}/TOC.md`;
  const tocContent = await safeReadFile(join(repoRoot, docsRoot, 'TOC.md'));
  if (tocContent == null) return []; // no <docsRoot>/TOC.md — nothing to check against

  const candidates = await listCandidateFiles(repoRoot, opts);
  const docsPrefix = `${docsRoot}/`;
  const docs = candidates.filter((f) => f.startsWith(docsPrefix) && f !== tocPath);

  const findings = [];
  for (const relPath of docs) {
    // <docsRoot>/TOC.md lives inside <docsRoot>/ itself, so it commonly links
    // siblings with a bare, docsRoot-relative filename (e.g. `foo.md`) rather
    // than the full repo-relative path (`<docsRoot>/foo.md`). A doc counts as
    // indexed if EITHER form appears in the TOC text.
    const docsRelPath = relPath.startsWith(docsPrefix) ? relPath.slice(docsPrefix.length) : relPath;
    if (!tocContent.includes(relPath) && !tocContent.includes(docsRelPath)) {
      findings.push({
        kind: 'orphaned-doc',
        ok: false,
        severity: 'info',
        detail: `${relPath} is not referenced in ${tocPath}`,
      });
    }
  }

  return findings;
}
