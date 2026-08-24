# 0041. Widening `scanRetiredTokens` to `<wikiDir>/` amends ADR-0015's wiki limb only; `raw/` stays unamended

- **Status:** accepted
- **Date:** 2026-08-20
- **Issue:** #366 (canonical), #383, #384, #386

## Context

ADR-0015 decision 1 rooted `wiki/` and `raw/` outside `audit-conventions`'
hygiene walk in one sentence, but for two different reasons: `raw/`
"legitimately holds retired tokens and dead links as part of its
captured-source record," and `wiki/` pages "churn on a different cadence than
curated reference docs." #366 asks whether that single sentence still holds
now that the wiki tier is a real, populated practice rather than a design
sketch — and finds that the two reasons don't age the same way.

Separately, #383 gives `.gvt-agent.json`'s documented-but-previously-unread
`paths` convention-file override a real resolver (`lib/path-overrides.mjs`),
wired into both `audit-conventions` validate mode and `--fix`. #384 uses that
resolver to derive the docs-tier walk root from `paths['docs/TOC.md']` across
all three hygiene scanners plus the stale-config `--fix` follow-up report,
and adds a `### Summary` line naming what was actually scanned. #386 is the
doc-completion half of this four-issue cluster, including fixing two
now-stale claims this cluster's own code changes created: `CONVENTIONS.md`'s
paths paragraph, and ADR-0022's verified-property claim about the hygiene
walk's boundary (see Decision).

## Decision

**`scanRetiredTokens` — and only `scanRetiredTokens` — now also walks
`<wikiDir>/`.** `scanBrokenLinks` and `scanOrphanedDocs` are untouched.
`<rawDir>/` is not walked by any scanner, at either the default repo-root
layout (already outside every walked root) or a nested layout (excluded at
its resolved, anchored path — never a bare directory name, since exclusion
matching is substring-based and a bare `"raw/"` would also swallow
`docs/draw/`). `.gvt-agent.json`'s `hygiene.excludePaths` gains one entry,
`wiki/audit-conventions-as-proto-lint.md`, for a page that legitimately
carries the scanner's own deny-list tokens as documented subject matter
inside inline code spans.

**This amends ADR-0015 decision 1's `wiki/` limb, and only for
`scanRetiredTokens`.** ADR-0015 gave two reasons for excluding `wiki/`, and
only one survives scrutiny — this is the heart of the record:

`raw/` was excluded on **legitimacy**: a finding there is a false positive by
construction, since the captured-source record is supposed to preserve
retired tokens and dead links verbatim. Clearing such a finding would mean
editing a file the repo's own immutability rule (stated at all 7 sites
enumerated in ADR-0022) forbids editing. That reasoning is untouched by this
decision, and the `raw/` limb is **reaffirmed unamended**.

`wiki/` was excluded on **cadence**: its pages "churn on a different cadence
than curated reference docs." Cadence bounds how *often* a finding shows up;
it does not make a finding **wrong**. A rotted invocation on a wiki page is
the same defect it would be on a `docs/` page, and — unlike `raw/` — it is
fixable by editing the page, which is exactly what the wiki tier exists to
do. Cadence was never a legitimacy argument; conflating it with `raw/`'s in
one sentence is what ADR-0015 got wrong for this one scanner.

The widening is confined to `scanRetiredTokens` because that is the *only*
hygiene concern `maintain-wiki`'s own `lint` verb does not already own.
`lint`'s checks are dead wiki-links, out-of-bundle links, orphaned pages,
stale pages, and optional `raw/` immutability (`plugin/skills/maintain-wiki/
SKILL.md`) — no retired-token check among them. Token drift on the wiki tier
was therefore genuinely unowned. Dead links and orphaned pages **are**
`lint`'s, and stay `lint`'s: `lint` resolves OKF §6.1 bundle-absolute targets
(`/page.md`) against `<wikiDir>/`, whereas `hygiene.mjs` treats a leading `/`
as repo-root-relative — widening `scanBrokenLinks`/`scanOrphanedDocs` to
`<wikiDir>/` would ship a second, differently-rooted, *wrong* implementation
of a check that already has a correct owner.

**Architecture — how this fits ADR-0015, ADR-0022, ADR-0014, ADR-0012/0013.**

- **ADR-0015 decision 2** ("`lint` never wired into `audit.mjs`") is
  **reaffirmed, and it is load-bearing rather than pro forma**: it is
  precisely *why* `scanBrokenLinks` and `scanOrphanedDocs` did not widen
  alongside `scanRetiredTokens` — those two concerns already have an owner in
  `lint`, and duplicating them into `audit.mjs` would be the coupling
  decision 2 exists to prevent. ADR-0015 decision 3 (`ingest` as a thin verb)
  is untouched.
- **ADR-0014** (config-file token scanning intersected with `git ls-files`,
  rather than the earlier all-`docs/**`-only shape) is the precedent that
  this scanner's scope has diverged from its two siblings before, on the
  merits, without the three needing to move in lockstep. This decision is
  the second instance of that shape, not a new pattern.
- **ADR-0022's decision 1** (the OKF bundle root is `<wikiDir>/`, no new
  config key) is **left untouched**: this decision introduces no config key
  of its own for the docs-root derivation — `#384`'s docs-root widening
  reuses `paths['docs/TOC.md']`, already covered by that ADR's "one
  directory, one name" rule.
- **ADR-0022's Decision-1 subsection** contains a claim this decision
  **corrects**, in the record rather than only in code: it stated, as a
  *verified property*, that "`hygiene.mjs`'s `DEFAULT_EXCLUDE_PATHS` and
  `listCandidateFiles` walk `docs/**.md` + repo-root `CLAUDE.md` only, so
  `wiki/` and `raw/` remain structurally outside it." That was true when
  written (2026-07-30) and is **false as of this decision** for
  `scanRetiredTokens`: it now also walks `<wikiDir>/`. It remains true for
  `scanBrokenLinks` and `scanOrphanedDocs`, and remains true for `<rawDir>/`
  against all three scanners. ADR-0022's own text is left as written — per
  this repo's practice of not revising a past record's body — with this ADR
  as the record of record for the correction; a future reader of ADR-0022
  should treat that one sentence as superseded by this one for the
  `scanRetiredTokens` / `wiki/` cell specifically.
- **ADR-0012** (config read from the resolved `configFilename`, never a
  hardcoded name, so a `stale-config` repo on `.genvid-agent.json` keeps
  working) and **ADR-0013** (the `--fix` skip-if-exists guard) are both
  **honoured** by #383/#384's path-overrides work: `evaluateFile`/
  `evaluateConfig` and the stale-config TOC scaffold target all resolve
  through `paths` read from the already-loaded config, and the scaffold's
  skip-if-exists check runs against the *resolved* target path, not the
  literal `docs/TOC.md` — so a consumer's own file at the overridden
  location is never silently overwritten.

## Compromise

Alternatives considered and rejected:

- **Widen `scanBrokenLinks` and `scanOrphanedDocs` to `<wikiDir>/` as well**,
  for a single "the wiki tier is hygiene-covered" story. Rejected: `lint`
  already owns both checks correctly-rooted against `<wikiDir>/` and OKF
  §6.1; a second, `hygiene.mjs`-rooted implementation would disagree with
  `lint` on bundle-absolute link resolution and could gate the audit's exit
  code on a wiki-content problem — exactly what ADR-0015 decision 2 exists to
  prevent.
- **Mask inline code spans in `scanRetiredTokens`** to suppress the two new
  findings on `wiki/audit-conventions-as-proto-lint.md:30` without an
  `excludePaths` entry. Rejected: stale invocations of a retired token are
  almost always written in backticks — masking inline code is close to
  masking the check's primary catch. #281 is the named, principled follow-up
  (an opt-in allow-marker) for this general problem; until it ships, the one
  page that documents the scanner's own deny-list pays with an exclusion
  entry instead.
- **Leave `wiki/` excluded (status quo)**. Rejected as the premise this
  decision revisits: it left a hygiene concern with no owner at all on a
  tier that, unlike `raw/`, is designed to be edited — the cadence rationale
  bounded frequency, not correctness, and conflating the two left a real gap
  standing.

## Consequences

- **Measured price:** widening adds exactly **2** `info` findings to this
  repo, both on `wiki/audit-conventions-as-proto-lint.md:30`, which documents
  the scanner's own deny-list and therefore carries `genvid:`/`genvid-c3` as
  subject matter inside inline code spans. Counterfactual re-run without the
  `excludePaths` entry: **14** `### Info (optional)` bullets; with it: **12**.
- **#281** remains the principled fix for the inline-code-masking question
  generally (an opt-in allow-marker) — not attempted here, for the reason
  given in Compromise.
- **`<rawDir>/`'s status at both layouts** is unchanged by this decision:
  already outside the walk at the default repo-root layout; excluded via its
  resolved, anchored path (never a bare directory name) on the rare nested
  layout, where a bare `"raw/"` would over-match (e.g. `docs/draw/`).
- **`migrate.mjs:864`'s `scanDanglingReferences`** still hardcodes
  `listMarkdown(repoRoot, 'docs')` — a known remaining `docs/`-hardcode,
  **explicitly out of scope** for this decision, recorded here so a later
  reader doesn't mistake it for audited-and-missed.
- **A correction is owed to `wiki/llm-wiki-pattern-in-gvt-dev.md:82-84`**,
  which currently reads as attributing stale-token detection to a scope of
  "`docs/**` and `CLAUDE.md` rather than to `wiki/`" — no longer accurate for
  `scanRetiredTokens`. Recorded here as a **pointer**, not performed by this
  decision: editing wiki page content is `maintain-wiki`/wiki-maintenance
  territory, additional scope beyond this doc-completion pass.
- **Method note:** neither `staleFollowup()` (the stale-config `--fix`
  manual-follow-up report, widened by #384) nor the `--fix` TOC scaffold
  target (resolved through `paths` by the commit closing out #383) is named
  in any of this cluster's issue bodies. Both were found by auditing call
  sites of the changed helpers rather than by re-reading the issues — worth
  recording as a technique, since a call-site audit catches consumers an
  issue-body-only pass would miss.
