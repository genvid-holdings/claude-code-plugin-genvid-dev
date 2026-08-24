---
name: audit-conventions
description: Validates the consuming repo against the genvid plugin's convention contract — walks every installed skill and agent's metadata.expects (required files, config keys, tools) and reports missing/mismatched items with the reason each was needed. Default mode is read-only; --fix migrates a legacy or greenfield repo to the new contract. Use to check whether a repo satisfies the plugin's expectations or to surface drift after a plugin update.
metadata:
  pillar: verify
  expects:
    config:
      - key: hygiene
        in: .gvt-agent.json
        required: false
        reason: Optional overrides for the advisory repo-hygiene scanners (retired-token deny-list, exclude paths); sensible defaults apply when absent.
    tools:
      - command: node
        reason: Runs the validator script
      - command: git
        reason: Reads repo metadata (remote, submodules) for state detection
---

# Audit Conventions

Validates the consuming repo against the `genvid` plugin's convention contract and reports findings.

**This skill ships a deterministic validator script.** The script does the actual checking; this body tells you when to run it, how to read the output, and how to act on findings.

## When to run

- After installing or updating the `genvid` plugin (the plugin may have added new expectations).
- Before opening a PR, to verify the repo still satisfies the contract.
- When `/gvt-dev:validate-changes` or another skill reports that an expectation isn't met.
- As the first step in a migration from the legacy template-rendered setup (see `--fix` mode below).

## Process

### 1. Run the validator

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-conventions/scripts/audit.mjs"
```

The script:

1. **Detects state** — greenfield (no `.gvt-agent.json` and no legacy submodule), legacy (has the `burbank-claude-config` submodule + old `claude-config.json`), or migrated (has `.gvt-agent.json` and no submodule).
2. **Walks the plugin's installed skills and agents** at `${CLAUDE_PLUGIN_ROOT}/skills/*/SKILL.md` and `${CLAUDE_PLUGIN_ROOT}/agents/*.md`.
3. **Parses each component's frontmatter** to collect `metadata.expects.{files,config,tools}`.
4. **Evaluates each expectation** against the current working directory.
5. **Prints a structured report** grouped by severity (errors for required-but-missing; warnings for non-fatal repo-health drift; info for optional-but-missing).
6. **Exits non-zero** if any required expectation is unmet (so the skill can be wired into CI).

### 2. Read the report

Each finding includes:

- The **component** that declared the expectation (skill or agent name).
- **What was expected** (file path, config key, tool command).
- **What was got** (missing, found-but-wrong-type, etc.).
- **The reason** the component needs it — verbatim from the component's `metadata.expects[].reason`.

When a required check is missing, take the reason seriously — it's what the skill author wrote down explaining the dependency.

### 3. Act on findings

- **Missing required file** — create it with project-appropriate content. The plugin's `CONVENTIONS.md` describes the expected shape of each convention file.
- **Missing required config key** — add the key to the named file (typically `.gvt-agent.json`) per the schema in `CONVENTIONS.md`.
- **Missing tool** — install the tool, or document in `CLAUDE.md` why the skill in question isn't usable in this repo. **Windows caveat:** the tool check probes the PATH of the *shell that launched the audit*, so a POSIX tool like `grep` (the `cleanup-initiative` requirement) reports **missing** from PowerShell but **present** from Git Bash, which puts `usr/bin` on PATH. That's an environmental difference, not a false positive — if a skill you actually use needs `grep`, run it from a shell that has the tool (or install it on the system PATH) rather than treating the finding as a bug.
- **State = greenfield** — run `/gvt-dev:audit-conventions --fix` to scaffold the four convention files.
- **State = legacy** — run `/gvt-dev:audit-conventions --fix` to migrate from the old template-rendered setup.
- **State = stale-config** — run `/gvt-dev:audit-conventions --fix` to rename `.genvid-agent.json` to `.gvt-agent.json` (or, for a C3-marker repo, get a port-and-keep plan) and resync `CONVENTIONS.md`.
- **`CONVENTIONS.md` drift warning (state = migrated or stale-config)** — run `/gvt-dev:audit-conventions --fix` to preview the resync, then `--apply` once reviewed.

## `--fix` mode

Two-step, and the two steps belong in **two separate turns**: dry-run to preview, hand the plan to the user, then `--apply` only once they've seen it and said go.

**Step 1 — preview the plan:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-conventions/scripts/audit.mjs" --fix
```

Prints the numbered list of actions that would be applied. No files are written. Surface the full plan to the user and **stop there.**

**Step 2 — apply the plan** (only after the user has seen the plan and approved it):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/audit-conventions/scripts/audit.mjs" --fix --apply
```

Executes the same plan against the filesystem and prints per-action results.

> **Don't collapse the two steps into one turn.** A request like "set this repo up" or "migrate us over" authorizes the *goal* — it is not standing approval to run a *specific plan the user hasn't seen yet*. The plan can include irreversible actions (deleting `claude-config.json`, deinit-ing and `git rm`-ing the submodule, overwriting `CLAUDE.md`); the whole point of the dry-run is to let the user veto a surprising action before it touches their tree. So present the numbered plan and wait for an explicit go-ahead, even when the original request sounds like a green light. The one exception is a non-interactive context (CI, a `--apply`-from-the-start instruction) where the user has already opted into unattended application.

### Behavior by state

- **Greenfield** — scaffolds `CLAUDE.md`, `CONVENTIONS.md` (copy of the plugin's canonical), `docs/TOC.md`, `.gvt-agent.json`. The scaffolded files have placeholders the user fills in. Any of these that **already exist** are left untouched and reported as SKIPPED — a repo can own a hand-written `CONVENTIONS.md` or `CLAUDE.md` while still classifying greenfield (no `.gvt-agent.json`), and the scaffold never overwrites existing content.
- **Legacy** — translates the old `claude-config.json` into `.gvt-agent.json` (mapping the project's real `PACKAGE_MANAGER` / `TEST_COMMAND` / validation commands into `commands.*`, not generic `npm` placeholders), adds the `@CONVENTIONS.md` import to `CLAUDE.md`, copies `CONVENTIONS.md` to the repo root, deletes the rendered `.claude/` files that came from the legacy templates (only files carrying the `AUTO-GENERATED` marker — and no `LOCAL EDIT` block — are deleted; user-edited and locally-extended files are kept and surfaced in the SKIPPED notes), ports legacy per-agent context sidecars (`.claude/agents/*/project-*.md`) to their new `docs/` homes, removes dangling references to the deleted files (the `pre-commit-lint.js` hook entry in `.claude/settings.json`, submodule-referencing `package.json` scripts), and removes the `burbank-claude-config` submodule via `git submodule deinit` + `git rm`. After applying, it prints a **Manual follow-up** report listing any stale text references (in `CLAUDE.md`, `docs/`) or orphaned sidecars it could not clean up automatically.
- **Migrated** — the plan is a `CONVENTIONS.md` resync, not a full scaffold/migration (the repo is already on the contract). Plain audit WARNS when the repo-root `CONVENTIONS.md` has drifted from the plugin's canonical copy; `--fix` offers a vetoable resync: absent → copy the canonical in; drifted → resync, with the dry-run showing a `+N/−M` line-count diff hint; identical → a no-op note, nothing to do. `--apply` still refuses a dirty working tree, same as any other state.
- **Stale-config** — the repo still carries the pre-rebrand `.genvid-agent.json`. `--fix` first checks for **C3 markers** (`features.c3` / `paths.c3project`): if present, it does **not** auto-rename (genvid-construct3 tooling may still read the file by its legacy name) and instead prints a port-and-keep note to copy the fields into a new `.gvt-agent.json` by hand while keeping the old file in place. Otherwise it `git mv`s `.genvid-agent.json` → `.gvt-agent.json` (preserving history) and scaffolds `CLAUDE.md` / `docs/TOC.md` skip-if-exists, same as greenfield. Either way, `CONVENTIONS.md` gets the same resync as the migrated state above (absent → copy; drifted → resync with a `+N/−M` hint; identical → no-op), via the shared resync planner. After `--fix` (both the dry-run preview and post-apply), a **`### Manual follow-up`** report lists any un-swept retired-token hits (`genvid:`, `genvid-dev:`, `.genvid-agent.json`) still present in `docs/**.md` + `CLAUDE.md`, with file:line — this report is **read-only, nothing is rewritten automatically**; auto-rewriting those tokens is deferred to a follow-up issue.

### Safety rails

- Refuses to **apply** on a dirty working tree (commit or stash first, so the migration lands as a clean reviewable diff). The dry-run writes nothing to your repo and previews fine on a dirty tree.
- **Preview and apply against the same tree.** The plan is recomputed from the *current* working tree on every run, so a file that changes between the dry-run and `--apply` can change which actions fire. To keep that from passing silently, the dry-run **persists** its plan (to the OS temp dir, keyed by repo — nothing is written to your repo) and `--apply` **reconciles** the recomputed plan against it, printing a line that names any previewed action that no longer applies — e.g. `Applied 53 of 54 previewed actions — 1 previewed action no longer applies (re-run --fix to see the current plan)`, plus a note when new actions appeared since the preview. It warns and proceeds; it never blocks. Since apply requires a clean tree, if you previewed on a *dirty* tree and then committed or stashed to clean it, the reconciliation line will flag any drift — re-run the dry-run on the now-clean tree to refresh the plan before applying.
- Doesn't auto-commit. The user reviews `git status` / `git diff` and commits manually.
- User-edited rendered files (no `AUTO-GENERATED` marker) are preserved — the plan reports them as SKIPPED so the user knows what was kept.
- Rendered files that keep the `AUTO-GENERATED` marker but add a `LOCAL EDIT` block are also preserved (never silently deleted) — the plan flags them as SKIPPED so their local content can be ported before the file is removed by hand.

The full migration logic is in `scripts/lib/migrate.mjs`; this skill body just explains when and how to invoke it.

## Output format

The script prints findings as Markdown so the report renders cleanly when Claude surfaces it back to the user. Example:

```markdown
## Audit Results

State: migrated

### Errors (must fix)
- **plan-task** expects `CLAUDE.md` — file not found. Reason: Read for project conventions, branching, commit format, and the inventory of project-specific implementer agents beyond ts-implementer.

### Warnings
- `repo.host` is `bitbucket` but the `origin` remote is a github URL — set `repo.host` to `github` in .gvt-agent.json (or update the remote).

### Info (optional)
- **code-reviewer** expects `docs/code-review-context.md` — file not found (optional). Reason: Provides project-specific context (architecture, domain rules) for review.

### Practice Coverage

| Pillar | Components | Adoption |
| --- | --- | --- |
| Spec | plan-task, analyst, designer, planner | not evaluated |
| Verify | audit-conventions, validate-changes, code-reviewer, validator | not detectable (#160 — write-eval never shipped, so there is no consumer-side artifact to detect) |
| Environment | maintain-wiki, wiki-librarian | adopted |
| Moldable | build-probe | n/a by design (ADR-0018 — build-probe deliberately ships no config block, doc, template, agent or repo artifact) |

### Summary
- required: 18 of 19 satisfied.
- optional: 11 of 12 satisfied.
- 1 required expectation unmet.
- 1 warning (non-fatal).
- 1 optional expectation unmet.
```

The **Warnings** section holds non-fatal repo-health flags that aren't tied to a component expectation — `repo.host` drift (the configured host disagrees with the `origin` git remote) and, for a **migrated or stale-config** repo, `CONVENTIONS.md` drift from the plugin's canonical copy (see Behavior by state above). Warnings are excluded from the required-expectations tally and never affect the exit code; an absent `repo.host`, an unresolvable/unrecognized remote, or an absent `CONVENTIONS.md` stays silent.

Also folded into **Warnings** and **Info** are three advisory repo-hygiene checks, scanning `docs/**.md` + `CLAUDE.md`: a **retired-token scan** (info) flags lines still using a deny-listed token (e.g. a pre-rebrand `genvid:` invocation); a **broken intra-repo markdown link check** (warning) flags a relative link whose target doesn't resolve on disk; a **`docs/TOC.md` orphan check** (info) flags a doc under `docs/` that no line of `docs/TOC.md` references. All three respect the optional `hygiene` config block (`retiredTokens`, `excludePaths` — see `CONVENTIONS.md`) and fall back to sensible defaults when it's absent. Like the `repo.host`/`CONVENTIONS.md` warnings above, **these three checks are purely advisory: they never affect the required-expectations tally or the exit code**, same framing as the host-drift and description-length checks — they surface repo-health drift for the user to act on, not a contract violation to fail CI over.

A fourth content scan, **principle-citation**, is different on both scope and severity: it only runs when the audit is run against this plugin's own source (a consuming repo can't fix the plugin's own citations), scans `plugin/**/*.md` (minus `CHANGELOG.md`) rather than `docs/**.md` + `CLAUDE.md`, and flags a citation to a `development-principles.md` principle number that doesn't exist in the doc's current list (a typo'd or stale citation number). Unlike the three checks above, this one is **`error` severity** — a mis-pointed citation silently repoints agent guidance at the wrong principle, a functional regression rather than a doc-tidiness gap, and `warning` findings never move the exit code (see ADR-0019 for the full rationale).

The fifth content scan, **pointer-anchor**, checks the repo's *positional* citations — a file path written with a line number. Such a pointer must carry a **content anchor** immediately after it: a quoted span, a backticked identifier, or a colon-introduced quotation naming what the cited line holds. The scan resolves the cited path to a real file and verifies the anchor against it, with three outcomes — the anchor sits inside the cited range (silent); it sits elsewhere in the target (**drift**, reported with the corrected line number so the fix is mechanical); or it is absent from the target entirely (**broken**). A pointer carrying an anchor and *no* line number is fully conforming and cannot decay, which makes the renumber-proof shape the cheapest way to comply — and it is exactly the remedy ADR-0037 decision (4) and ADR-0042 already prescribe for a decayed positional pointer; this scan makes that convention enforceable rather than merely remembered. The citing corpus is `.md` and `.mjs` under the repo-root `docs/` and `plugin/` trees, minus the `audit-conventions-evals/` fixtures, and — diverging deliberately from `principle-citation` — it **includes `plugin/CHANGELOG.md`**, because release-note prose cites agent bodies by line and some of those pointers occur nowhere else in the repo. Severity is **`error`**, gated to runs against this plugin's own source like `principle-citation`, but the gate is load-bearing for a different reason: this corpus reaches the repo-root `docs/decisions/` tree, which consuming repos also have, so the gate — not the scanner's reach — is what keeps the convention off a consumer's ADRs (ADR-0047 has the argument). Running at `error` against a corpus that doesn't conform yet needs a **ratchet**: a repo-root baseline file records already-accepted pointers so existing debt doesn't block every change. Entries are keyed by citing file, pointer text, and occurrence — never the citing line number, so an acceptance survives its own document being renumbered — and each carries a digest of the cited target's content, so an accepted pointer re-fires if that target is rewritten underneath it. **No baseline file means everything reports**; absence is the loud state, and an unreadable or malformed baseline is treated identically. A companion script beside `audit.mjs` maintains that baseline: it prunes by default and writes nothing unless asked, and adding entries takes an explicit opt-in flag that refuses outright, with no write, while any pointer is provably wrong. One known gap — that refusal covers the drift and broken kinds, so a newly added pointer that merely *lacks* an anchor can still be accepted.

**Practice Coverage** is a report section rather than a content scan, and it carries no findings at all — it's purely advisory, and a pillar showing `not adopted` can never move the exit code, by construction rather than by policy (there's no severity to assign it in the first place). It maps the plugin's four practice pillars (Spec, Verify, Environment, Moldable — declared via the opt-in `metadata.pillar` frontmatter key documented in `CONVENTIONS.md`'s "Practice-layer pillar declaration" section) against two columns that answer two different questions: **Components** is the plugin-side census — which installed skills/agents declare `metadata.pillar` for that pillar — while **Adoption** is the consumer-side verdict for the repo actually being audited. Today only Environment has a working consumer-side detector (the wiki); every other pillar reports **`not evaluated`**, meaning no detector exists yet for that pillar, not that the repo failed one. `not detectable` and `n/a by design` are likewise deliberate states, not gaps to close: Verify is `not detectable` because `write-eval` never shipped (#160 — there's no consumer-side artifact to look for), and Moldable is `n/a by design` because `build-probe` intentionally ships no config block, doc, template, agent, or repo artifact to detect (ADR-0018). Neither should be read as "TODO" or "unimplemented." A `> Pillar gap:` line appears only when a pillar has zero components declaring it. A related author-time check, **pillar-unknown**, warns on an unrecognized `metadata.pillar` value; like the README-inventory and principle-citation checks, it's gated to runs against the plugin's own source tree and can never fire in a consuming repo's audit.

Exit code: 0 if no errors (warnings alone keep it 0); non-zero if any required expectation is unmet.

## CI integration

To wire audit into CI, invoke the script from a pre-merge step:

```bash
node /path/to/genvid/skills/audit-conventions/scripts/audit.mjs
```

Outside Claude Code, `${CLAUDE_PLUGIN_ROOT}` isn't substituted. In CI, either resolve the plugin's install path at job setup, or check the script in as a wrapper that points at the installed plugin (the plugin install lives in `~/.claude/plugins/cache/...` for user-scope installs).
