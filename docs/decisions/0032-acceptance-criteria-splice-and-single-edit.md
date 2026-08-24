# 0032. Acceptance-criteria writeback: tolerant-match/canonical-heading, one section per body, and the write is the body's only scheduled edit

- **Status:** accepted
- **Date:** 2026-08-12
- **Issue:** #245, #274, #290

## Context

ADR-0017 pinned Phase 4 step 4's `## Acceptance Criteria` write as the
mechanism that makes `gvt-dev:validator` and `gvt-dev:code-reviewer` grade
against a fixed target. That mechanism was under-specified in three ways
that #245, #274, and #290 each surfaced independently: what happens when the
issue body already carries a heading that reads as acceptance criteria but
isn't spelled exactly `## Acceptance Criteria`; what "append or insert"
means precisely enough that an edit can't silently truncate a live tracker
body; and what happens when this step's write is not the only edit a plan
schedules against the same issue body. None of the three has an automated
check — `gh issue edit --body-file` is a whole-value store with no diff
view, so a defect in any of them is invisible until a human reads the
issue.

## Decision

**Tolerant match inbound, canonical heading outbound.** The matcher accepts
a `##`-level heading, matched at line start and outside fenced code blocks,
whose text — lowercased, trailing punctuation stripped — reads `acceptance
criteria`, `acceptance criterion`, or a straightforward singular/plural
variant. `##` only: a `###` sub-heading or a heading carrying extra words
(`## Acceptance criteria (proposed)`) is a near miss, not a match. Whatever
spelling matched, the write always emits the body back out under the exact
canonical `## Acceptance Criteria` — the heading `validator.md:42` ("read its `## Acceptance Criteria` section") and
`code-reviewer.md:101` ("the pre-committed `## Acceptance Criteria` checklist") read literally. The body is rebuilt from three parts —
prefix (everything before the matched heading), span (heading through the
next `## ` boundary or end of body), suffix (that boundary onward) — never
from a line-number offset, since a `grep -n` offset is valid only for the
body it was read from and a shift silently truncates a live tracker issue
while the edit command reports success. No match degenerates to the append
case (prefix = whole body, suffix = empty). This is stated as an algorithm
in prose that the session's own file-reading/writing tools carry out, not
an executable recipe — `plan-task` declares only `git` as a required tool,
so a shell splice would either widen every consuming repo's aggregated
contract or ship unrunnable (`grep`/`awk` are absent from the Windows
PowerShell `PATH` this repo already works around elsewhere).

**Exactly one acceptance-criteria section per body, not per plan.** For a
combined plan (ADR-0029), only the canonical body carries the section; each
sibling gets a pointer comment and no section of this plan's making. Within
a single body, the match above resolves to one of three outcomes: (1) no
existing section → insert; (2) an existing section this checklist
supersedes → replace in place, opening the new section with a mapping from
old items to new (`orig-1 → R1+R2`, …) and naming by number any criterion
the original could not have contained — the mapping is what lets a reader
verify nothing was dropped, since a whole-value write leaves no diff to
check against; (3) an existing section this checklist does not cover, or a
near-miss heading → surface it at the checkpoint as an explicit fork,
never silently discarded and never silently kept alongside the new one.

**This write is the only edit of that body this plan schedules.** A plan
can legitimately need the target issue's body touched a second time — a
planner-emitted task annotating scope discovered during planning, or the
*reconcile the issue body in the same PR* instruction the superseded-
mechanism gates already give in Phase 1 and in the full-proposal shortcut
— but a second `--body-file` round-trip against the same body races this
write with no ordering guarantee and no pathspec equivalent to scope it
down: the second call reads its own copy of the body first, and if that
read lands before the first edit, the second write clobbers it with no
error surfacing. The fix is to fold the second edit's content into this
write rather than schedule it separately, leaving one edit that carries the
pledge and the scope correction together. A scheduled edit aimed at a
*sibling* is a different case and stands alone: a sibling has no
acceptance-criteria write to fold into (it gets a comment, never a
checklist), so if its body genuinely needs an edit it is that body's only
scheduled edit, lands after the sibling's pointer comment, and never adds
an acceptance-criteria section of its own. `plugin/agents/planner.md` gets
the same rule mirrored preventively as a Key Principle, since the racing
task is exactly the kind of thing a planner would otherwise emit.

This fits the existing architecture as a specification of ADR-0017's
existing step, not a new phase, gate, schema, or scanner: the read/rebuild/
write mechanics extend the `bugTracker.readOne` + host-native edit
round-trip ADR-0017 and ADR-0029 already established, reused unchanged.

## Compromise

Alternatives considered and rejected:

1. **Tolerate-and-preserve the matched spelling**, writing the section back
   under whatever heading text was already there instead of normalizing to
   the canonical form. Rejected: it breaks the literal reads at
   `plugin/agents/validator.md:42` ("read its `## Acceptance Criteria` section") and `plugin/agents/code-reviewer.md:101` ("the pre-committed `## Acceptance Criteria` checklist"),
   pulling two `area:agents` files into scope that neither #245, #274, nor
   #290 names, and it makes ADR-0017's fixed-heading guarantee false in
   practice for any body whose existing heading was a near-exact variant.
   Normalizing on write keeps both graders correct with zero edits to
   either file.
2. **Ship an executable splice recipe** (`awk`/`sed`), as #290 originally
   proposed. Rejected on contract grounds: `plan-task`'s
   `metadata.expects.tools` declares only `git`, so a shell recipe would
   either widen the aggregated contract every consuming repo's audit checks
   against, or ship unrunnable in the one environment this repo already
   documents as broken for exactly this class of tool (Windows PowerShell
   `PATH` lacks `grep`/`awk` — the same gap that produces the audit's false
   `cleanup-initiative expects grep` failure). A prose algorithm the
   session's own tools execute has no such dependency.
3. **Keep the three rules duplicated inline** across the *Issue present*
   and *Multiple target issues* bullets rather than hoisting them into a
   shared block. Rejected: duplicated, the two bullets would run to roughly
   4,500 and 3,200 characters — the bloat all three issues independently
   flagged as unreadable — and a rule repeated at two sites is a live drift
   surface with several more issues already queued against this bullet.
4. **Extract the rules into a `plan-task/` sub-doc**, on the precedent of
   `multi-session.md` and `approval-and-audit.md`. Rejected: those hold
   phase-adjacent material a reader reaches by an explicit go-read-this
   instruction, whereas this is a mid-step mechanic every execution must
   follow, and the failure mode the source issues describe is improvisation
   under time pressure — a rule that costs a file-open is the rule most
   likely to be improvised past rather than read. It is also thematically
   backwards here: #290's finding is that an existing pointer *over-
   promised* what the target actually specified, so answering it with a
   second pointer risks the identical defect. The right point to revisit
   this is if the block later outgrows the step it lives in.
5. **Fold a sibling-targeted body edit into the sibling's pointer comment**
   instead of letting it stand alone as that body's own scheduled edit.
   Rejected: the clobber this decision guards against requires two edits
   racing on *one* body, and a sibling has exactly one scheduled edit (the
   pointer comment itself, plus at most one more), so the hazard is
   structurally absent — forcing a scope correction into a comment is a
   constraint no observed failure motivates.
6. **A separate planner-owned body-edit task**, splitting the acceptance-
   criteria write and the scope-annotation edit across two owners instead
   of merging them into one. Rejected: splitting writers across a
   destructive whole-value boundary (`gh issue edit --body-file` has no
   partial-update form) is the shape of the bug, not a fix for it — the
   robust pattern is one writer, always starting from a fresh read,
   matching the "this write always starts from a fresh `readOne`" rule
   already stated for chained-run safety.

## Consequences

`validator.md` and `code-reviewer.md` needed no edits — normalize-on-write
keeps their literal `## Acceptance Criteria` reads true regardless of what
heading text an issue body arrived with. The grader-side gap for a
criterion neither grader can honestly pass or fail remains tracked on #241,
unchanged by this decision.

This record does not contradict ADR-0029; it is the same guard restated at
finer grain. ADR-0029's *"exactly one artifact ever carries checklist
rows"* and its rejected canonical-plus-body-stub alternative stand intact —
this decision's *a sibling's scheduled edit never adds an acceptance-
criteria section* is that guard applied to the new single-edit-per-body
rule, not a departure from it. ADR-0029's *"whole-body writes stay at 1
regardless of N"* argued against N *checklist* copies across siblings; an
unrelated annotation on one sibling's own body doesn't touch that count.

ADR-0017's fixed-heading requirement is preserved, not loosened: what
changed is tolerance on the *read* side only, and `metadata.expects` is
untouched — no new schema, engine, or scanner was added, matching ADR-0017's
own constraint.

The rule could not be exercised by the run that authored it: this repo
dogfoods `plan-task` from the installed plugin cache, which lags source
until a release (see `CLAUDE.md`'s dogfooding caveat). This change's own
Phase 4 acceptance-criteria write was therefore performed by hand from the
plan rather than by the updated skill.

A future editor of the splice/single-section/single-edit rules has one
shared block to update (`plugin/skills/plan-task/SKILL.md`'s *"Writing the
section into an issue body"* subsection) plus the mirrored
`plugin/agents/planner.md` Key Principle — two sites, not the four to six
the pre-hoist duplication would have left behind.
