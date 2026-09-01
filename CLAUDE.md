# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this repo is

This repo is the **`gvt-dev` plugin** for Claude Code: shared skills, agents, hooks, and conventions used across Genvid game projects. It is published through a separate marketplace repo, [`GenvidTechnologies/claude-code-gvt-marketplace`](https://github.com/GenvidTechnologies/claude-code-gvt-marketplace) (catalog name `gvt-plugins`, shared with `gvt-construct3`).

Consuming repos install the plugin via Claude Code's `/plugin install` flow — there is **no submodule, no template engine, no render step**. Skills and agents are flat files that read project context at runtime from a small convention contract (`CLAUDE.md`, `CONVENTIONS.md`, `docs/TOC.md`, `.gvt-agent.json`) in the consuming repo.

The contract itself is documented in [`CONVENTIONS.md`](plugin/CONVENTIONS.md).

## Repo layout

The plugin lives under `plugin/` (published as a **git-subdir** to the marketplace); the repo root holds this repo's own dogfood contract, maintainer notes, examples, and eval harnesses.

```
claude-code-plugin-gvt-dev/
├── plugin/                           # The published plugin (git-subdir source)
│   ├── .claude-plugin/plugin.json    # Plugin manifest
│   ├── CONVENTIONS.md                # Public contract (canonical source)
│   ├── CHANGELOG.md                  # Plugin changelog (versioned consumer surface)
│   ├── skills/<name>/SKILL.md        # One directory per skill
│   ├── agents/<name>.md              # Flat .md files (not directories)
│   ├── hooks/
│   │   ├── hooks.json                # Hook wiring (PreToolUse on Bash)
│   │   └── pre-commit-lint.js        # The actual hook script
│   ├── docs/
│   │   └── development-principles.md # Shared reference imported by skills/agents
│   └── skeleton/                     # Pristine placeholder files greenfield --fix writes (source of truth for the scaffold)
├── .gvt-agent.json                # This repo's own contract config (dogfood — makes genvid skills work here)
├── .pointer-baseline.json         # Accepted-debt ratchet for the pointer-anchor scan (regenerate with pointer-baseline.mjs, never hand-edit)
├── docs/
│   ├── TOC.md                        # This repo's documentation index (dogfood)
│   ├── issue-triage.md               # Dogfood consuming-repo triage conventions
│   └── plugin-authoring.md           # Maintainer authoring notes (internal, not shipped)
├── examples/                         # Worked, filled-in example consuming-repo files (Bunny game) for reference
└── audit-conventions-evals/          # Skill eval harness (developer tooling)
```

**Important layout details:**

- **The plugin lives under `plugin/`** — `plugin/.claude-plugin/plugin.json` plus `plugin/skills/`, `plugin/agents/`, `plugin/hooks/`, `plugin/docs/`. The repo root carries only this repo's dogfood contract (`.gvt-agent.json`, `docs/TOC.md`, `docs/issue-triage.md`), maintainer notes (`docs/plugin-authoring.md`), `examples/`, and the `*-evals/` harnesses.
- **Skills are directories** (`plugin/skills/<name>/SKILL.md`). The directory can include supporting files (sub-docs, scripts).
- **Agents are flat files** (`plugin/agents/<name>.md`). Subdirectories are NOT discovered by the plugin loader.
- **`plugin/skeleton/` is the scaffold's source of truth.** The greenfield `audit-conventions --fix` copies `plugin/skeleton/{.gvt-agent.json,CLAUDE.md,docs/TOC.md}` verbatim into a new repo (and `plugin/CONVENTIONS.md`). Edit the placeholder there, never a JS string literal. `plugin/skeleton/` holds *empty placeholders*; `examples/` holds a *filled-in* worked example — different purposes (see `plugin/skeleton/README.md`).
- **This repo dogfoods its own contract.** It carries a real `.gvt-agent.json` and `docs/TOC.md` at the repo root so the genvid skills (`plan-task`, `run-retro`, `validator`, …) work when developing the plugin itself. The audit therefore classifies this repo as `migrated`, not `greenfield`.
- **Dogfooding caveat — the installed cache lags the source.** Skills and agents invoked in this repo run from the **installed plugin cache** (`~/.claude/plugins/cache/gvt-plugins/gvt-dev/<version>/`), not from `plugin/`. Unreleased `SKILL.md`/agent edits don't take effect here until a release + `claude plugin update`. So when developing the very skills you're dogfooding, you may exercise *older* behavior than what's in source. If a dogfooded skill behaves differently from its working-tree `SKILL.md`, that's why — read the working-tree version (or update the local install) before trusting the run. *(Concrete example: `plan-task`'s "orchestrator owns the commit, gate before commit" rule from `af84d49` is post-`v3.0.0`, so running `plan-task` against the `v3.0.0` cache still uses the older commit-then-validate flow.)* This is why `run-retro` §1 requires a plugin-repo retro to verify each finding against working-tree source before proposing it.
- **The lag hides *missing instructions*, not just stale behavior — and those are undetectable from inside the run.** The caveat above triggers on "a dogfooded skill *behaves differently* from its working-tree `SKILL.md`," which presumes you have something to compare against. That holds for a stale **claim** — you read the artifact and the disagreement surfaces — but not for a stale **instruction**: the cache's `SKILL.md` never says "a step is missing here," so absence produces no signal and no amount of care inside the run recovers it. (Concrete example: a 2026-08-03 session ran `plan-task` from the `4.3.0` cache while source was `4.4.0`, and silently skipped the ADR-0017 step requiring the `## Acceptance Criteria` checklist be written to the **issue body** before execution — `plugin/skills/plan-task/approval-and-audit.md`'s "Acceptance criteria recorded" step, which the 4.3.0 text simply doesn't contain. The criteria stayed in the gitignored, transient `plan.md` until after the commit landed, which is the exact failure ADR-0017 exists to prevent.) So when running a plugin orchestrator (`plan-task`, `plan-next-issue`, `triage-issues`, `run-retro`) **inside this repo**, diff the cache against source *before starting*, not only once something looks wrong: `diff ~/.claude/plugins/cache/gvt-plugins/gvt-dev/<version>/skills/<name>/SKILL.md plugin/skills/<name>/SKILL.md`. Gate it on the cheap version check first — `plugin/.claude-plugin/plugin.json` `version` vs. `git tag -l 'v*' | sort -V | tail -1`; equal means cache and source agree and the diff is unnecessary. Note this is the half that #201's `run-retro` §1 gate *cannot* cover: that gate verifies findings, which are claims about source and therefore checkable; an instruction you never received is not.
- **So when the unreleased delta touches the orchestrators you are about to dogfood, cut the release *first*.** The two caveats above diagnose the hazard; this is the decision that follows from them, and it is cheap — a cycle whose bump already landed releases with a CHANGELOG-only commit, a tag, and a marketplace `ref` bump. Weigh it *before* planning, not after: the alternative is not "plan now, release later" but "plan with tooling you cannot inspect from inside the run." Judge the delta by whether it is *finished*, not by how large it is — the blocking question is whether an unfinished chain is mid-flight (see the branch-at-the-start rule below), not whether the diff is big. *(Worked example: on 2026-08-06 a `plan-next-issue` run found `plugin.json` at 4.5.0 against tag `v4.4.0` — 4 commits, 7 `[Unreleased]` bullets, none of them an unfinished chain. That delta **was** the planning tooling: `plan-task`'s design-time split path, the premise-correction rule for a moving tree, the co-staged numeric-criteria rule, and the `designer`/`planner` positive-control rule. Releasing first, then `/plugin update`, made all four available; the plan written minutes later (#243) used them, shipping a positive control on every zero-hit-adjacent criterion. Had the release waited, the run would have silently omitted all of it.)* Note the reverse case is equally real and needs no release: a delta touching only `plugin/` components you are **not** about to invoke changes nothing about the run, so this is a targeted check, not a standing "always release before planning" rule. `plan-next-issue` does not surface the delta on its own (#251), so raise it yourself until that ships.

## Commands

```bash
# Validate the plugin manifest and component frontmatter
claude plugin validate plugin

# Re-install / update the local plugin from the marketplace
claude plugin marketplace add https://github.com/GenvidTechnologies/claude-code-gvt-marketplace.git
claude plugin install gvt-dev@gvt-plugins
claude plugin update gvt-dev@gvt-plugins
claude plugin details gvt-dev

# Run audit-conventions tests
node --test plugin/skills/audit-conventions/scripts/test/*.test.mjs

# Run the audit script against this repo or any consuming repo
node plugin/skills/audit-conventions/scripts/audit.mjs           # validate
node plugin/skills/audit-conventions/scripts/audit.mjs --fix     # dry-run a migration
node plugin/skills/audit-conventions/scripts/audit.mjs --fix --apply  # apply

# Maintain the pointer-anchor ratchet (.pointer-baseline.json) — never hand-edit it
node plugin/skills/audit-conventions/scripts/pointer-baseline.mjs                  # prune-only dry run: drops entries matching nothing, adds none
node plugin/skills/audit-conventions/scripts/pointer-baseline.mjs --write --accept-new  # also accept new debt; refuses, with no write, while any pointer is provably wrong
```

**On Windows, run the audit via the Bash tool, not PowerShell.** The audit checks each skill's declared tools against `PATH`; `cleanup-initiative` expects `grep`, which isn't on the PowerShell `PATH`, so a pwsh run falsely reports `1 required expectation unmet: cleanup-initiative expects grep — not found on PATH` (exit 1). git-bash has `grep`, so the same audit exits 0 there. If you see only that `grep` line as "unmet", it's an environment artifact, not a widened contract — re-run under bash to confirm.

**`commands.validate` chains the audit, so run the *whole* `validate` under Bash on Windows.** `.gvt-agent.json` `commands.validate` runs `claude plugin validate` + the skill test suites **and** `audit.mjs` — the audit is the gate that catches contract-widening, so it belongs in the full check rather than as a separate step someone can forget. The consequence of folding it in: the entire `validate` command (and any `gvt-dev:validator` / `validate-changes` dispatch that runs it) trips the same false `grep` failure above if run under PowerShell. Run `commands.validate` via the Bash tool on Windows, and treat a green `validate-changes` as the complete contract check only when it ran under Bash.

## Self-declaring skill / agent metadata

Every skill and agent in the plugin uses YAML frontmatter with custom `metadata.expects` declaring its prerequisites. The `audit-conventions` skill reads these declarations and validates them against the consuming repo.

```yaml
---
name: plan-task
description: Third-person what+when description — used by Claude for routing.
metadata:
  expects:
    files:
      - path: CLAUDE.md
        reason: Required file
      - path: docs/ARCHITECTURE.md
        required: false
        reason: Optional file
    config:
      - key: project.name
        in: .gvt-agent.json
        reason: Required config key
    tools:
      - command: git
        reason: Required tool
---
```

- Top-level frontmatter stays Anthropic's standard (`name`, `description`, `tools`, `model`).
- Custom data goes under `metadata` so `claude plugin validate` doesn't reject it.
- `required: true` is the default; only `required: false` is written. Mark a prerequisite `required: false` when it's **skill-conditional** (only one skill needs it) rather than part of the universal contract — the audit aggregates required expectations across all skills, so a skill-specific required file would make unrelated repos fail. The `package.json` expectation in `publish-npm-package` is the canonical example.
- The `reason` field is mandatory and load-bearing — it's what `audit-conventions` prints to explain why a missing item matters.

See [`CONVENTIONS.md`](plugin/CONVENTIONS.md) for the full contract.

## Adding a new skill

1. Create `plugin/skills/<verb-noun-name>/SKILL.md` with frontmatter (name, description, optional metadata.expects).
   - **Keep the `description` ≤ 1536 chars** (`skillListingMaxDescChars`). Over that, it's silently truncated in the session skill listing — degrading the routing signal the description exists for — and nothing in `claude plugin validate` flags it. The audit now warns (author-time only, on a maintainer/dogfood run against the plugin source) when a skill or agent description exceeds the cap; keep the audit's desc-length warnings at zero. Descriptions regress over the cap easily, so re-check after any description edit.
   - **Don't put a `: ` (colon-space) inside the unquoted `description`.** Frontmatter `description`s are YAML *plain scalars*, and a colon-space is YAML's mapping indicator — so `description: Foo bar: baz` parses as a nested map and the frontmatter fails to load (`claude plugin validate` reports "YAML frontmatter failed to parse … loads with empty metadata," silently dropping every field). Descriptions are long and prose-y, so this sneaks in easily (a `maintain-wiki` description shipped `…existing wiki: dead links…` and broke the build). Use an em-dash (`—`) or reword instead; the same applies to any long unquoted scalar (`reason:` fields included).
2. Avoid skill names containing `claude` or `anthropic` (reserved by Anthropic's validator).
3. Prefer verb-noun names that read alone (`commit-changes`, not `commit`) — avoids collisions with built-in Claude Code skills.
4. Verify with `claude plugin validate plugin`.
5. **Run the audit** — `node plugin/skills/audit-conventions/scripts/audit.mjs` (exit 0) — to confirm any new `required: false` expectations stayed optional and didn't widen the aggregated contract (see [Testing](#testing)). **Exit 0 is necessary but not sufficient for the author-time obligations:** `hasErrors` counts only `error`-severity, so none of these move the exit code. A green exit therefore does **not** prove the README/TOC inventory rows (step 6/7) or the description cap were satisfied. **But the three findings do not share a severity, and therefore do not share a report section — which decides where you have to look:**

| Finding | Severity | Rendered under |
|---|---|---|
| `readme-inventory` (new skill/agent missing from `README.md`) | `warning` (`lib/readme-inventory.mjs`) | `### Warnings` |
| `desc-length` (over-cap description) | `warning` (`audit.mjs`) | `### Warnings` |
| `orphaned-doc` (a `docs/` page not indexed in `docs/TOC.md`) | **`info`** (`lib/hygiene.mjs`) | **`### Info (optional)`** |

So **"read the Warnings section and confirm it's empty" catches the first two and structurally cannot catch the third** — an un-indexed doc renders under `### Info (optional)` and reads like an unmet *optional expectation*, indistinguishable at a glance from the dozen benign ones this repo always carries. For step 7's `docs/TOC.md` row, **read `docs/TOC.md` and confirm the row is there** — the same rule the Testing section states for ADRs, and for the same reason: the audit is not a reliable oracle for index rows. Use the Warnings section for the README row and the description cap. Those two **warning**-severity findings are the author-time ones of the three, and they **auto-activate when the audit runs against the plugin repo itself** — the gate (`AUDITING_PLUGIN_SOURCE` in `audit.mjs`) is *path-derived* from the audited path being this repo's root, **not** an environment variable you export — so the same plain `node plugin/skills/audit-conventions/scripts/audit.mjs` from the repo root already includes them; there's nothing extra to enable, and a `Warnings` section is simply absent when there are none. **`orphaned-doc` is not author-time and is not gated:** `scanOrphanedDocs` is invoked alongside the other hygiene scanners, outside the gate block, so it fires in a *consumer's* audit too, against that consumer's own `docs/` tree. It appears in the table above for where it renders, not because it shares the other two's gating (see [ADR-0049](docs/decisions/0049-audit-core-mechanism-policy-boundary.md)). Note that "gated" does not mean "inside the block" — `desc-length` self-gates with an early return rather than sitting in it, which the paragraph below unpacks.

   **Two author-time checks are deliberately *not* warnings: `principle-citation` and `pointer-anchor`.** `principle-citation` (a skill/agent citing a `development-principles.md` principle number that doesn't exist) and `pointer-anchor` (a positional citation — a path plus a line number — carrying no content anchor, or an anchor that isn't where the pointer says) are both **`error`-severity, so they *do* fail the audit and therefore `commands.validate`.** Both sit behind the same `AUDITING_PLUGIN_SOURCE` gate as the two warnings above, so neither can ever fire in a consumer's audit — but the gate is doing different amounts of work in each case. `principle-citation` scans `plugin/` only, which a consumer doesn't have, so it would find nothing there even ungated; `pointer-anchor`'s citing corpus reaches `docs/decisions/`, which consumers *do* have, so there the gate is the *only* thing keeping the anchor convention off a consumer's ADRs (see [ADR-0047](docs/decisions/0047-pointer-anchor-checker-error-severity-and-ratchet.md)). Don't generalize the "author-time findings never move the exit code" rule from the two warnings above to every author-time check; severity is a per-check decision on the merits (see [ADR-0019](docs/decisions/0019-principle-citation-error-severity.md)).

   **The gate is enforced at *two layers*, so "is the call inside the `if` block?" reads only half the gated set.** Three checks are gated **at their call site**, inside the `if (AUDITING_PLUGIN_SOURCE)` block: `readme-inventory`, `principle-citation` and `pointer-anchor`. Two more are called *before* that block opens and **gate themselves internally**, with an early `if (!AUDITING_PLUGIN_SOURCE) return []`: `desc-length` and `pillar-unknown`. Both layers produce the same behaviour — nothing fires in a consumer's audit — but only the first is visible by reading the call site, which is why an enumeration built that way is wrong in a specific, repeatable direction: it **silently omits the self-gating checks** while looking complete. That is not hypothetical. `pillar-unknown` was missing from every prior enumeration in this repo — ADR-0019, ADR-0047, `CLAUDE.md` and the issue that set out to correct them — and a 2026-08-28 pass that fixed the `orphaned-doc` misclassification reproduced the same error in the act of fixing it, by relocating `desc-length` *into* the block it self-gates outside of. When enumerating the gated set, check both mechanisms: grep the block's contents **and** grep for the early-return guard.

   Practical consequence when *authoring*: you cannot write a worked example of a **bad** principle citation anywhere under `plugin/`, and you cannot write an illustrative **positional pointer** — a path plus a line number, outside a fence — anywhere under `plugin/`, `docs/`, or the repo root's tracked markdown (**this file included**, since the citing corpus widened to it). Both fire for real. The pointer constraint is the stricter of the two, because **it cannot be baselined away either**: `audit-conventions`' `scripts/test/pointer-baseline-guard.test.mjs` pins the pointer strings this repo swept and fails if any of them reaches `.pointer-baseline.json`, so an illustrative pointer is neither clearable nor acceptable. The escape hatch is a **fenced code block** — the scanner skips fences — so put an example pointer inside a fence; for a bad principle citation, describe the failure mode in prose instead of illustrating it with a live number.
6. **`plugin/CHANGELOG.md`** — add an `[Unreleased]` entry. A new invocable skill is consumer-visible surface, so it needs a version bump and a changelog note.
7. **`docs/TOC.md`** — add a one-line Components entry for discoverability (especially orchestrators or skills carrying notable config — the `triage-issues` line is the precedent).
8. Smoke-test by updating the local install (`claude plugin update gvt-dev@gvt-plugins`) and checking `claude plugin details gvt-dev`.

**If the new skill orchestrates other skills** (invokes them via the Skill tool rather than doing the work itself — e.g. `plan-next-issue` chains `triage-issues` → `plan-task`), keep it a *pure orchestrator*: it owns no exploration and no writes, it sequences the delegated skills and makes only the decisions *between* them. Redeclare any config it reads (e.g. a `bugTracker` key consulted to rank candidates) in its own `metadata.expects` as `required: false` — accurate, and since it's optional the audit's aggregated contract is unaffected. This differs from the agent-dispatching orchestrators (`plan-task`) and from the two-surface external-system pattern below: a pure orchestrator introduces no new agent, template, or contract file of its own.

**If the skill needs project-specific config for an external system** (a bug tracker, CI, a dashboard — anything the plugin can't infer), follow the **two-surface pattern** rather than hardcoding one tool or stuffing prose into JSON:

- **Structured access mechanics** → a namespaced top-level block in `.gvt-agent.json` (e.g. `bugTracker`: queries, command templates, key names). Lean, machine-read. Declared in the skill's `metadata.expects` as `required: false` (skill-conditional — see `CONVENTIONS.md`).
- **Prose conventions + recipes** → a doc under `docs/` in the consuming repo (e.g. `docs/issue-triage.md`): taxonomy, policies, and the tracker-specific command recipes. Located by fixed headings.
- **A bundled template** alongside the skill (e.g. `plugin/skills/triage-issues/issue-triage.template.md`) that the skill offers to scaffold into the consuming repo when the doc is absent — never guess conventions. When one contract has materially different shapes across repos, ship **multiple template variants** (e.g. `issue-triage.template.md` for a structured taxonomy vs. `issue-triage.flat.template.md` for a flat label set) and have the scaffold step **auto-select by probing the repo** (e.g. `gh label list` for a `type:`/`priority/` prefix), confirming the detected default rather than asking blind. **When the scaffolded doc lands under `docs/`, the scaffold step must also self-index it in `docs/TOC.md`** — add a one-line entry under a conventional section heading (offer interactively, auto in `--non-interactive`, idempotent, skip gracefully if `docs/TOC.md` is absent). The planning/triage skills discover docs *through* that index, so an unindexed scaffolded doc is invisible to them — the gap behind #90. `plan-task`'s `docs/decisions/` indexing (under `Decision Records`) and `triage-issues`'s `docs/issue-triage.md` indexing (under `Process`) are the precedents.
- **A read-only exploration agent** (e.g. `issue-triage-analyst`) that does the fetching/analysis off the main thread and returns a structured report, so the orchestrator skill keeps the main context for decisions and writes. `triage-issues` is the reference implementation.

## Adding a new agent

1. Create `plugin/agents/<name>.md` — **flat file**, not a directory.
2. Agent frontmatter supports `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, plus custom `metadata`.
3. Skills dispatching the agent use `subagent_type: "gvt-dev:<name>"` — plugin agents are namespaced.

## Renaming a skill or agent

A rename touches more than the file — work the whole cross-reference surface:

1. **`git mv`** the file/directory (and any bundled sub-docs/templates) so history is preserved. *(Windows: `git mv` of a whole directory under an active file-watch — e.g. `plugin/skills/` — can fail with "Permission denied" while a node/editor process holds a watch handle; move its children individually into the new parent, then remove the emptied dir.)*
2. **Frontmatter `name:`** in the moved `SKILL.md` / agent `.md`, plus the body title and self-references.
3. **Dispatch references** — every `gvt-dev:<old-name>` (skills dispatching an agent) and `/gvt-dev:<old-name>` invocation mention.
4. **`metadata.expects` paths** — a renamed scaffolded doc (e.g. `docs/<x>.md`) is declared in *both* the skill and its agent.
5. **Cross-doc references** — `plugin/CONVENTIONS.md`, `CLAUDE.md`, `docs/TOC.md`.
6. **Tracker label / metadata descriptions** — an issue-tracker label whose *description* names the skill (e.g. the `triaged` label's `set by /gvt-dev:triage-issues`) is a cross-reference the repo-file scanners never see; update it with the tracker CLI (`gh label edit <name> --description …`). This surface is **invisible to `audit-conventions`' retired-token scan** (it walks `docs/**.md` + `CLAUDE.md` only), so it drifts silently across a rename or rebrand — exactly how the `triaged` label's description outlived both the #92 rebrand and the `triage-bugs`→`triage-issues` rename before this retro caught it.
7. **`plugin/CHANGELOG.md`** — add an `[Unreleased]` migration note; **leave shipped version entries intact** (they record what actually shipped).
8. **Leave `docs/superpowers/specs|plans/` historical artifacts unchanged** — they're dated design records.
9. **Decide config-schema scope** — a namespaced config block (e.g. `bugTracker`) can keep its name to avoid a consumer config break even when the skill is renamed; if so, note the intentional decoupling.
10. **Consumer impact** — a renamed invocation name or scaffolded doc path is **breaking**: it needs a version bump and a CHANGELOG migration note.
11. **Verify** — `claude plugin validate plugin` and `node plugin/skills/audit-conventions/scripts/audit.mjs` (exit 0).

## Adding shared reference content

Reference docs that multiple skills/agents import live at `plugin/docs/`. Reference them via `${CLAUDE_PLUGIN_ROOT}/docs/<filename>.md` — the substitution works in skill and agent content (but NOT in CLAUDE.md `@`-imports), and `${CLAUDE_PLUGIN_ROOT}` resolves to the `plugin/` directory.

Sub-docs specific to one skill live alongside that skill (e.g., `plugin/skills/plan-task/multi-session.md`).

When adding a **new** doc: add it to `docs/TOC.md` and an `[Unreleased]` `plugin/CHANGELOG.md` entry. Whether it needs a **version bump** depends on the doc's audience — and the move splits the two kinds across two directories:

- **Runtime-imported reference content** (pulled in by a skill/agent via `${CLAUDE_PLUGIN_ROOT}/docs/…`, e.g. `development-principles.md`) lives at `plugin/docs/`, ships to consumers, and is part of the plugin's behavioral surface → **bump**.
- **Maintainer/authoring notes** read only by humans working *on* the plugin (e.g. `docs/plugin-authoring.md`) stay at the repo-root `docs/` and are internal → CHANGELOG entry for traceability, **no bump**.

## Releasing a new version

Use `/gvt-dev:release-plugin` — it owns the full release runbook: assessing repo state (and distinguishing a stale local checkout from a genuine inconsistency), bumping `plugin/.claude-plugin/plugin.json` `version`, moving the `plugin/CHANGELOG.md` `[Unreleased]` section, authoring the `release: vX.Y.Z` commit, pushing the annotated `vX.Y.Z` tag, bumping the plugin's `source.ref` in the marketplace catalog, and handing off the consumer-facing `/plugin update` step. The skill reads `paths.plugin_root` (`"plugin"`) from `.gvt-agent.json` to resolve those paths.

The marketplace catalog ([`claude-code-gvt-marketplace`](https://github.com/GenvidTechnologies/claude-code-gvt-marketplace)) pins this plugin by a **plain annotated `vX.Y.Z` tag** via the `source.ref` field in its `.claude-plugin/marketplace.json`, using a `git-subdir` source with `"path": "plugin"` — the tag string (minus `v`) must equal `plugin/.claude-plugin/plugin.json` `version`. Consumers pick up a release with `/plugin update gvt-dev@gvt-plugins`.

## Conventions in this repo

- **Commit messages**: scope-based freeform (`<scope>: <description>`), no ticket prefix. The `BUN-XXXX` format in `examples/` is illustrative of a *consuming* game project, not this repo. Individual commits carry the harness-standard `Co-Authored-By:`/`Claude-Session:` trailers when Claude Code authors them; since PRs are **squash-merged**, those per-commit trailers are collapsed away at merge, so the convention that reaches `main` is just the squash message — don't rely on the trailers surviving.
- **Branches**: descriptive kebab-case, no prefix (e.g., `split-marketplace`).
- **A feature chain that can't ship within one release cycle branches at the start, not at the end.** Landing the first link of a multi-issue feature on `main` makes `main` unreleasable for as long as the chain runs — and everything else merged meanwhile is held hostage with it. The cost is not the unfinished feature; it is that *finished, unrelated* work cannot ship, while the dogfood cache keeps lagging source (see the dogfooding caveat above) and the open backlog keeps rotting against a moving `plugin/`. Judge this **when the first link lands**, not when the release is wanted: if the work is already scoped as a chain of issues, assume it will outlast the cycle. *(Worked example: `maintain-wiki` arrived via #143 as the first of a five-issue chain — #183 → #189, #190, #191, #192, plus #150 and #146. By 2026-08-04 that left 23 commits and 32 `[Unreleased]` CHANGELOG bullets unreleasable, of which only 2 bullets were the unfinished feature; the other 30 were finished refinements and fixes to already-released components. Unwinding it retroactively was judged too expensive — it was woven through five ADRs, `CONVENTIONS.md`, two other skills, and the dogfood `wiki/`+`raw/` trees — so the rule is worth applying up front, where it is free.)* Note the release surface is `plugin/` only (git-subdir), so a repo-root-only chain does not create this problem.
- **Merging PRs**: merge commits are disabled — PRs are **squash-merged** (`gh pr merge <n> --squash`). A `--merge` will be rejected by the repository.
- **Skill names**: verb-noun, namespaced as `/gvt-dev:<name>` at invocation time.
- **Agent dispatch references** inside skills: always namespaced (`gvt-dev:validator`, `gvt-dev:analyst`, etc.).
- **Versioning**: `plugin/.claude-plugin/plugin.json` carries a semver `version`. Bump it when shipping a meaningful change to skills/agents/hooks — but **once per release cycle, not once per change.** Compare `version` against the newest release tag (`git tag -l 'v*' | sort -V | tail -1`) and read the result **in both directions** — the rule has two cases, and only one of them is the one people remember:

  - **`version` is *ahead* of the newest tag** → this cycle's bump has already happened. Add your `[Unreleased]` CHANGELOG entry and **leave `version` alone**. Otherwise a second change in the same unreleased cycle double-bumps and desyncs the tag/marketplace `source.ref` contract.
  - **`version` is *equal* to the newest tag** → this cycle's bump has **not** happened, and **your change owns it**: bump `version` alongside your `[Unreleased]` entry. Equal is the state a release leaves behind, so it is exactly what you find when you are the *first* change after one — and it is now common, because the release-before-dogfooding rule above makes "release, then plan the next thing in the same session" the normal sequence rather than an edge case. *(Worked example: on 2026-08-07 a session cut `v4.6.0` mid-run and then planned #251 minutes later; `plugin.json` read 4.6.0 against tag `v4.6.0`, so that change correctly bumped to 4.7.0.)* The `[Unreleased]` entries' own "→ version bump at release" phrasing is the tell: the bump belongs to the *release*, which `release-plugin` owns — not to each change.
- **CHANGELOG entry shape**: each `[Unreleased]` bullet **closes with its version-bump verdict** — "New invocable skill → version bump at release.", "Behavioral skill/agent change → version bump at release.", "No consumer-facing behavior change → no version bump." That clause is the entry's tail by convention, so when a later change **amends an existing entry** (the right move when the entry's subject hasn't shipped yet — a second `[Unreleased]` entry about the same unshipped surface is noise), the new sentence goes **before** the verdict, not after it. Appending past the tail reads as a second verdict and breaks the scan-the-last-clause habit the convention exists for.
- **Release tags**: plain annotated tags named `v<semver>` (e.g. `v2.0.0`). The marketplace pins by `source.ref` in `.claude-plugin/marketplace.json`, which must match the tag name exactly (tag minus `v` == `plugin/.claude-plugin/plugin.json` `version`).
- **License**: MIT-0 (`LICENSE` at repo root).

## Testing

The plugin has no top-level test runner (no `package.json`, no npm). The audit-conventions skill ships its own unit tests using native `node --test`:

```bash
node --test plugin/skills/audit-conventions/scripts/test/*.test.mjs
```

For skill/agent **content**, `claude plugin validate` catches schema errors, manual review catches content drift, and `claude plugin details` confirms the plugin's component inventory after changes.

**`audit.mjs` itself is orchestration-only — put testable logic in `lib/`.** The `audit.mjs` entrypoint has no exports, so its inline helpers (`evaluate*`, `formatReport`) aren't unit-testable. When a change adds logic worth pinning with a test, extract it into `lib/<name>.mjs` with a companion `test/<name>.test.mjs`, as the #151 summary-tally fix did (`lib/summary.mjs` + `test/summary.test.mjs`). One consequence to keep in mind: because `formatReport`'s exact rendered strings live in that un-exported entrypoint, the report *wording* has no test — only the extracted tally math does. Extracting the format itself (or an integration test that runs the script against a fixture) is the way to cover it.

**Executing a TDD-style plan for skills/agents** (e.g. via the superpowers `writing-plans` / `subagent-driven-development` flow): there's no test runner to make "write the failing test" literal, so map red→green onto the tools that exist. **Red** = a presence/structural check that fails before the file exists (`test -f …`, or a `grep` for required headings/frontmatter). **Green** = that same structural check passing, plus `claude plugin validate plugin`, plus `node plugin/skills/audit-conventions/scripts/audit.mjs` exiting 0 (proves new `required: false` expectations stayed optional and didn't widen the contract). Commit per task as usual.

**Adding a content-scanning check to `audit-conventions`** (a scanner that greps file *content* — retired tokens, broken links, TOC orphans — rather than validating `metadata.expects` presence): its acceptance gate must include **running the audit against this repo itself and confirming zero new findings** (`node plugin/skills/audit-conventions/scripts/audit.mjs`, exit 0). This repo is the toughest fixture the check will ever see — it carries frozen historical artifacts that legitimately trip naive scanners: `CHANGELOG.md`, `docs/superpowers/`, and `docs/decisions/` hold retired plugin-name tokens as accurate history (they're in the hygiene `excludePaths` defaults for exactly this reason), `docs/plugin-authoring.md` cites a sibling plugin's since-superseded name (now `gvt-construct3`) as correct-as-history prose (excluded via this repo's own `.gvt-agent.json` `hygiene` block), and `docs/TOC.md` links its siblings with bare filenames (not `docs/`-prefixed paths). Dogfooding the scanner here is what surfaces the needed exclusions and the real bugs — the `#131` orphan-check bare-filename bug and the `excludePaths` merge-vs-replace ergonomics were both caught this way, not by the unit tests.

**When a scanner is supposed to *ignore* a surface** (an `excludePaths` entry, or a directory structurally outside its walk — e.g. a repo-root `wiki/`/`raw/` that the `docs/`-scoped scanners never visit), *prove the exclusion actively rather than inferring it from reading the code.* Temporarily inject exactly what the scanner should skip — a retired token, a dead relative link — into a real file on that surface, re-run the audit, and confirm the finding count is **unchanged**; then revert the injection before committing. An inject-confirm-revert probe demonstrates the surface is genuinely outside the scanner's reach; reading `listCandidateFiles` and reasoning that it "shouldn't" match is weaker evidence and misses a scanner that widened its walk. (This is how the #143 dogfood wiki proved the hygiene scanners ignore repo-root `wiki/`: injecting a retired plugin-name token + a dead link into a `wiki/` page left the finding count at 18→18. Note the injected token is a *literal* only in the throwaway probe — don't leave a real retired token in `CLAUDE.md` or a `docs/` page, since the retired-token scanner walks those and would flag it.)

**An excluded surface cuts both ways — "audit green" does not verify a doc the audit never walks.** The same `excludePaths` and walk-scoping that keeps frozen history from tripping the scanners also makes anything on those surfaces *unverifiable* by the audit, at any severity. `docs/decisions/` is the sharp case: it's in `hygiene.mjs`'s `DEFAULT_EXCLUDE_PATHS`, and `scanOrphanedDocs` draws its candidates from `listCandidateFiles`, so **a new ADR missing its `docs/TOC.md` row is invisible to the audit** — exit 0 says nothing about it. This matters when a change's acceptance criteria pair "audit green" with a doc-index row (the `#189` shape): the audit criterion reads like the catch-all gate and silently doesn't cover its sibling. Verify any TOC/index row by reading the file; never infer it from the exit code. Note this is a *different* failure from the author-time warnings above — those are scanned but `warning`-severity, so they're visible in the report and merely don't move the exit code; an excluded path isn't scanned at all and produces no finding to read.

For skill **behavior** — does Claude wielding the skill do the right thing? — there's a skill-level eval harness under [`audit-conventions-evals/`](audit-conventions-evals/) (see its README). It runs the skill against fixture consuming-repos via subagents and grades behavioral assertions (ran the validator vs. hand-rolled, identified state, previewed `--fix` before applying, stopped at the dry-run for approval). It's worth building one for a skill whose correctness is **objectively verifiable, state-dependent, or safety-gated**; judgment-heavy workflow skills (most of the plugin) don't need it. The harness is developer tooling — it requires Claude subagents, so it doesn't run in CI.
