# 0029. A combined plan pledges its acceptance criteria to one canonical issue, with a pointer comment on each sibling

- **Status:** accepted
- **Date:** 2026-08-10
- **Issue:** #261

## Context

`plan-next-issue` §3 explicitly produces a **combined plan** over several
related issues — one branch, one `plan.md`. But `plan-task` Phase 4 step 4
resolved *"the target issue"* — singular — and wrote one `## Acceptance
Criteria` section to it. The plural case was simply unspecified, so the
outcome was **run-dependent**: whatever the run improvised. ADR-0017's value
depends on the pledge target being predictable, so the requirement here is
**determinism**, not "stop a known silent drop" — the one recorded run (in
`construct3-chef`) improvised full duplication onto both bodies rather than
dropping one, and that run is unverified from here.

## Decision

When the chain resolves more than one existing issue, write the checklist to
exactly one — the **canonical**, defined as the **lowest issue number** among
the deduped targets — and post a tracker **comment** pointer on each sibling.
Never a second body section. The canonical write lands first; sibling
pointers follow, since a pointer asserts the canonical already carries the
section.

**Why lowest issue number:** it's deterministic, computable from the handoff
with zero tracker reads, and stable across entry paths. Since issue numbers
are monotonic within a repo, it *is* this repo's own duplicate-cluster
tiebreak ("the oldest") restated — restated in the skill body rather than
referenced from `docs/issue-triage.md`, because `plan-task` has no dependency
on that doc and adding one would widen its `metadata.expects`.

This fits the architecture as an addition to the existing Phase 4 step 4
mechanics (ADR-0017's `bugTracker.readOne` + host-native edit round-trip),
reused unchanged for the canonical write, plus the tracker's existing
host-native comment command for the sibling pointers — no new `bugTracker`
field, no new phase, no new gate. `gvt-dev:validator` and
`gvt-dev:code-reviewer` are told which issue is canonical explicitly at
dispatch, rather than each re-deriving it from the chain.

Implemented in `plugin/skills/plan-task/SKILL.md` (the **Multiple target
issues (combined plan)** bullet in Phase 4 step 4, and the canonical-naming
addition to the validator/code-reviewer dispatch steps),
`plugin/skills/plan-task/approval-and-audit.md` (the self-audit checklist
item), `plugin/CONVENTIONS.md` (the `bugTracker` block description), and
`plugin/skills/plan-next-issue/SKILL.md` (stating that the handoff carries
every selected issue number, not just the first, so `plan-task` can detect
the plural case rather than infer it).

## Compromise

Alternatives considered and rejected:

1. **Full duplication** (the originating run's improvisation) — write the
   complete checklist to all N bodies. Rejected on four counts: (a)
   non-drift fails *structurally* — N independently-editable copies; (b) it
   makes three sentences **false** without editing them, in files
   deliberately out of scope — `plugin/agents/planner.md:55` ("the single
   target two independent critics grade against"), `planner.md:62` ("the
   single pre-committed target"), `plugin/agents/code-reviewer.md:101` ("the
   fixed target both … independently check against") — because the graders
   resolve the checklist *through* the issue body with no rule for picking
   among N, so N bodies removes the referent those sentences depend on; (c)
   an inventory of 8 candidate issues in this repo found 8 of 8 already
   carry a `## Acceptance criteria` section, so duplication trips issue
   #245's pre-existing-section trap on **every** target of **every**
   combined plan, not rarely; (d) `gh issue edit --body-file` is a
   whole-value store, so N writes means N whole-body re-emissions and N
   transcription-risk surfaces.
2. **Per-issue partition** — split rows by owning issue. Rejected: rows
   don't partition cleanly (validation and doc rows cover the PR, not one
   issue); `planner.md` emits per-plan and per-task criteria and **never**
   per-issue ownership, so this would need an out-of-scope agent change; and
   it collides with `create-pr`'s *"only add a keyword for an issue the PR
   **fully** resolves"* by making each issue read narrower than the work
   closing it.
3. **`docs/acceptance/<slug>.md` as the combined-plan home** — attractive
   (dissolves the tiebreak, zero body writes) but rejected: the file lives
   on an unmerged branch, so a reviewer reading an issue *during execution*
   — precisely ADR-0017's audience — cannot reach it; and it contradicts
   ADR-0017's Home-B-primary stance in exactly the case that ADR was written
   for.
4. **Canonical + body stub** — a stub section in each sibling body instead
   of a comment. Rejected: any heading a wording-tolerant matcher
   recognises recreates the two-coexisting-headings condition #245 exists
   to prevent; any heading it doesn't recognise is a section nobody looks
   for. A comment gets the same redirect with no body write at all.

## Consequences

Exactly one artifact ever carries checklist rows, so two pledges cannot
disagree. Whole-body writes stay at 1 regardless of N. #245's question is
engaged exactly once, on the canonical, exactly as today — so that issue's
three-way question stays genuinely open. The sibling pointer *redirects* a
grader that lands on a sibling, improving the known grader-side gap (tracked
on #241, deliberately out of scope here) rather than worsening it, with no
`area:agents` edit. Cost: one indirection, and a comment is easier to scroll
past than a heading — a future change to the grading path should account for
that visibility gap rather than assume the pointer is always followed.

**Also recorded in this branch (a second, smaller decision):** Phase 4 step
6's ADR-commit-ordering rule gained a carve-out for a record whose content
depends on something execution produces — most commonly a follow-up issue
number for a deferred-scope decline — authoring and committing such a record
*after* that dependency resolves, and saying so in the plan's task ordering
rather than leaving it a silent deviation (#262).
