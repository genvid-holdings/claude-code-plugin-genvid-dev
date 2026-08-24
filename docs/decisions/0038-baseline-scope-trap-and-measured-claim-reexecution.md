# 0038. A measured figure is re-derived by executing it — the baseline-corpus scope trap and the full-proposal measured-claims gap

- **Status:** accepted
- **Date:** 2026-08-16
- **Issue:** #324 (canonical), with #326 as spanned sibling

## Context

#324 and #326 were planned and executed as one change around a single
primitive: a measured figure is re-derived by executing something, not by
reading it. Two gaps fed that primitive. #326's Phase-3 cross-check already
had the planner re-derive a Test Criteria row's expected value against the
live tree, but stopped one hop short — it never reached the row's **baseline**
or its **positive control**, both of which are themselves measured figures a
planner can silently transcribe rather than re-run. #324's full-proposal
shortcut had no gate at all for a proposal's **measured** claims: the existing
artifact cross-check (development principle #13) verifies a proposal's
concrete content against a file it can open, but a benchmark, a platform
matrix, a collision rate, or a timing figure has no artifact to open — a
planner satisfying the artifact check diligently still sails past a false
measured claim.

The decisions landed in five commits on this branch: `a08f30f` (designer, the
scope-trap owner and a forward-citation sub-bullet for #332), `14f82d6`
(planner, supplied-control confirmation as item 12's final sub-bullet),
`e1bcf46` (`plan-task`, citing the baseline-reach and scope-trap rules at
Phase 3), `2e50b36` (`plan-task`, gating the full-proposal shortcut on
measured claims, mirrored at Phase 1), and `b7a261c` (`plan-task`, the
measured-figures self-audit item). This record is the durable home for the
ownership and carve-out decisions a future editor of this cluster would
otherwise have to re-derive from two issue threads and five commits.

## Decision

**(1) The baseline-corpus scope trap gets a new owner: `designer.md` item 8,
group 2 (*Is the expected value right?*), landed at `designer.md:93`.**
Minting a new owner is ADR-0036's exception, not its default — the standing
rule is cite-and-repeat. It applies here because anchored greps found **no**
existing statement of the rule anywhere under `plugin/`: a baseline measured
over a narrower corpus than the row asserts over is defective even though the
measurement itself was correct (a figure taken on one file, written into a
row asserting it across a directory). This was the only genuinely ownerless
rule of #326's four candidate gaps. The other three were discharged by
citation, not by a new bullet: baseline-must-be-measured is already owned at
`designer.md:89` (*"Measure the baseline by running the row's own command
against the pre-change tree — never assert one from reading the file"*);
vacuity (a baseline that already satisfies the pass condition) is already
owned at `planner.md:66`; and the baseline re-run clause the planner needs at
transcription time already shipped at `plan-task/SKILL.md:98` in #330
(*"'Verbatim' governs the row's wording, not its truth"*).

**(2) The comparison-control rule is a SPECIALIZATION of `designer.md`'s
empty-collection/mutation bullet (group 4, `designer.md`'s "A behavioural
assertion whose expected value is an empty collection" bullet), NOT a
widening of the positive-control zero-hit bullet (group 1, `designer.md:83`).**
This is the forward requirement for **#332**, deliberately sequenced behind
this change so it has something to cite — the new sub-bullet (`designer.md`'s
"The same shape arrives as a" sub-bullet) states only that a before/after
*comparison* asserted identical (an empty diff) fails the same two zero-hit
remedies for the same reasons as the empty-collection case, and that its
control is a mutation run once in a configuration known to differ. Three
reasons `designer.md:83` was rejected as the extension point: (a) wrong axis
— `:83` sits in group 1, *Is the pattern right?*, and a before/after
comparison row has no pattern to be right or wrong about; (b) `designer.md`'s
"A positive control evaluated against the" bullet is the nearest neighbour in
the file and steers the *opposite* way (*"Prefer the corpus form wherever it
expresses the same intent"*), so citing `:83` would hand #332 an argument
against its own row shape; (c) `:83` anchors a three-site byte-exact steer —
`grep -c "Prefer the count" plugin/agents/designer.md` → **3**, currently at
`designer.md`'s "A criterion whose pass condition is zero hits", "A criterion's expected value must be satisfiable", and "A row that already answers can it fail" bullets — that ADR-0037 Decision (3) already pinned as
churn-sensitive. `designer.md`'s "A behavioural assertion whose expected
value is an empty collection" bullet already owns the exact epistemic
position a comparison row shares — an empty result cannot distinguish
"correctly absent" from "structurally incapable of being non-empty" — and
already prescribes a mutation as the remedy; the new sub-bullet extends it
rather than opening a parallel statement.

**(3) `plan-task` is a citer site, not an owner site** (ADR-0036:156-158). Its
three new passages — the Phase-1 mirror (`SKILL.md:72`), the full-proposal
shortcut gate (`SKILL.md`'s "Run the validator gate inline" bullet), and the
Phase-3 baseline/control cross-check (`SKILL.md:102`) — cite `designer.md`'s
and `planner.md`'s owning bullets by
quoted text and mint no new general rule. The shortcut gate and the Phase-1
mirror share one **byte-exact** steer sentence per the cite-and-repeat
convention (ADR-0033(a)) — *"Structural precision is not evidence of
empirical precision"* — pinned at exactly **2**
(`grep -c "Structural precision is not evidence of empirical precision" plugin/skills/plan-task/SKILL.md`
→ 2).

**(4) DELIBERATE CARVE-OUT — `approval-and-audit.md:25` was left byte-exact
for #239, and #325 is entangled with it.** ADR-0036:218-221 reserves that
sentence for open issue **#239**. Three forks were weighed for the
self-audit's measured-figures gap: (a) widen `:25` in place — rejected, it
would be that sentence's *third* widening, would leave #239's eventual editor
a very large item, and crucially **would not resolve #239** (whose axis is
whether a prescribed verification command can ever pass at all — is its
pattern anchored — which a measured-figure clause does not reach); (b) carve
out and add nothing — rejected, the checklist the orchestrator actually runs
would then never name a measured figure at all; (c) **chosen** — carve out
`:25` byte-exact and add a *new adjacent* item (`:26`) that names itself
complementary to `:25` rather than parallel with it. Verified by **sha256 of
line 25 before and after the edit — identical**
(`794a8154985b5dac819db44336f193c1edd71a859f676008864d84839ba70bef`), not by
grep count, since a count of 1 is also consistent with an edit landing
elsewhere in that same long line. Open issue **#325** — the follow-up naming
the grader-side vocabulary gap for an unfalsifiable row, filed during
ADR-0036's own execution — is entangled with the same region for the same
reason #239 is: both are future edits to `approval-and-audit.md`'s premise
cluster. **Restate the pointer: a future editor touching `:25` still checks
both #239 and #325 before assuming the item's current shape is final.**

**(5) DELIBERATE CARVE-OUT — `designer.md`'s `git stash` worked example
(`designer.md`'s "A row that already answers can it fail" bullet) is #332's
to repair, not this change's.** It is the only `git stash` occurrence under
`plugin/`
(`grep -c "git stash" plugin/agents/designer.md` → **1**), and this change's
criteria pin it unchanged so an accidental absorption into the new
comparison-control prose would be detectable. The new sub-bullet
(`designer.md`'s "The same shape arrives as a" sub-bullet) says nothing about
`git stash` vs. a merge-base anchor, and deliberately declines to pre-decide
#332's `[point-in-time]` marking for a comparison row — handing #332 the
anchor-survives-the-branch criterion instead, because `designer.md`'s "A
behavioural assertion whose expected value is an empty collection" bullet's
closing caveat (a mutation is usually re-runnable after merge, so marking it
`[point-in-time]` unconditionally would itself be a mismarking) interacts
with #332's row, and that interaction is #332's to resolve, not this
change's.

**(6) ADR-0037's fire test was applied and does NOT fire — no sixth group.**
Both new rules extend an existing group's axis rather than opening a new one:
the scope trap extends group 2's baseline chain (`designer.md:89` is *how* to
measure a baseline; the new rule at `:93` is *over what corpus*), and the
comparison-control rule extends group 4 as a sub-bullet under `designer.md`'s "A behavioural assertion whose expected value is an empty collection" bullet, not as a
third top-level lead. Bolded-lead distribution moves from the measured
baseline **2/2/2/2/1 = 9** (ADR-0037:22) to **2/3/2/2/1 = 10** — group 2 gains
the one new top-level lead, group 4's new sub-bullet is nested and does not
add to its count. On the receiving side, applying ADR-0037:192-195's mirror
test: the new `planner.md` item-12 sub-bullet (*"A control the design
supplied is confirmed against the corpus it names, the same way a supplied
baseline is"*) is a **mirror, not a capability cut** — the planner has no
capability the designer lacks for confirming a supplied control's corpus, the
same way it does for a supplied baseline — so it takes its own appended
sub-bullet at the end of item 12 rather than extending an existing one,
exactly as #305's set-coherence sub-bullet did in ADR-0037.

**(7) A finding worth recording for the next editor: the set-level coherence
check has a blind spot.** The design screened its new prose against two
banned literals (`"Prefer the count"`, `"git stash"`) but **not** against the
criteria table's own pinned spans. One row, T12c, pinned
`grep -c "Measure the baseline by running the row's own command against the pre-change tree"`
over `designer.md` at **1** as a diff-hygiene survival assertion — while the
scope-trap bullet this same plan inserts quotes that sentence **in full**
(`designer.md:93`). The row was therefore **unsatisfiable by construction**:
the mirror of a vacuous row — a criterion that cannot pass rather than one
that cannot fail — and *defective* (born wrong) rather than *decayed*. Caught
during execution of Task 1, amended in the open on #324 to an expected **2**
(original + citation;
`grep -c "Measure the baseline by running the row's own command against the pre-change tree" plugin/agents/designer.md`
→ 2 today), matching T3's existing shape in the same table.

**Corrected during the post-merge retro — the first draft of this decision
overstated the finding, and the correction is the more useful record.** It
claimed a *generalizable new rule* was needed: "a set-level coherence check
must screen new prose against every span the criteria table itself pins." That
is not new. `designer.md:92` already rules on this exact shape and prescribes
the remedy T12c failed to use:

> **A pinned total** (`grep -c X` → 2, unchanged) — assert the **invariant**,
> not the total: that the pre-existing occurrences survive, as a **floor**
> (`≥` the measured baseline) **so an added citation cannot fail it**, plus a
> canonical-form rule for any added occurrence.

T12c was written as an **exact pin at 1** rather than a floor. The shipped
rule anticipates precisely the failure that occurred, and had it been applied
the row would have read `≥1` and passed untouched.

**What is genuinely unaddressed is narrower, and sits in a seam.** `:92`
states the floor remedy for the *whole-file-count* case, then offers an
alternative — *"Where the surviving sites must be pinned individually, pin
each by its full byte-exact sentence rather than by a whole-file count"* — and
**the floor does not carry forward to that alternative.** But a `grep -c` on a
byte-exact sentence is still a count, and a citation still moves it. T12c took
the byte-exact-sentence form and inherited no floor with it. Closing that seam
is filed separately; it is a one-clause change to `:92`, not a new rule.

**Closed by ADR-0042.** #340 lands exactly that one-clause change: the
byte-exact-sentence alternative under `:92` now pins each surviving sentence
as **`≥1`, not `=1`**, so the floor this decision's remedy already gave the
whole-file-count case now covers its individually-pinned alternative too —
see that record for the change itself.

**The meta-lesson is the one worth keeping:** a retro finding written up
without re-reading the shipped rule it supposedly generalizes will overstate
itself, and an ADR is exactly where that error compounds — every later
planning run that cites this record would have inherited a "new rule" that
already existed in stricter form. This is `run-retro` §1's verify-against-
source gate doing its job on this record's own author.

This fits the existing architecture as a further extension of `designer.md`
item 8 / `planner.md` item 12's five-named-group Test Criteria cluster
(ADR-0037) and of the plan-time cross-checks `plan-task` already runs against
that cluster (ADR-0021, ADR-0030) — no new phase, gate, schema, or scanner.

**Dogfooding caveat, per ADR-0037's own style:** the invoked agent bodies
(`designer.md`, `planner.md`) and `plan-task/SKILL.md` were diffed against
this repo's installed plugin cache before this session's dispatches — cache
`4.15.0` matched working-tree source byte-for-byte — so this run exercised
current guidance throughout. The version this change ships takes effect here
only after a release and a `/plugin update`.

## Compromise

Alternatives considered and rejected:

1. **Widening `designer.md:83`'s zero-hit positive-control bullet to cover a
   comparison row**, rather than specializing the empty-collection/mutation
   bullet. Rejected per decision (2): wrong axis (group 1 is about pattern
   soundness, not cross-row settleability), the nearest-neighbour text at
   `designer.md`'s "A positive control evaluated against the" bullet argues the opposite direction, and `:83` is already a pinned
   three-site steer this change had no reason to put at further churn risk.
2. **Widening `approval-and-audit.md:25` in place** rather than adding a new
   adjacent item. Rejected per decision (4): it would be that sentence's third
   widening, would not resolve #239 (whose axis a measured-figure clause
   cannot reach), and would leave the self-audit's measured-figures gap
   unaddressed if the widening were deferred instead.
3. **Repairing `designer.md`'s `git stash` worked example in this change**,
   since the new comparison-control sub-bullet sits one bullet away from it.
   Rejected per decision (5): the repair is #332's, its criteria depend on the
   `[point-in-time]` marking question #332 is scoped to resolve, and this
   change's own criteria pin the worked example unchanged so an accidental
   absorption stays detectable rather than silent.
4. **Firing ADR-0037's regroup tripwire for a sixth named group.** Rejected
   per decision (6): both new rules extend an existing group's axis rather
   than opening a genuinely new one, so the tripwire's own fire condition
   (an axis a named group cannot honestly house) is not met.
5. **Landing the comparison-control rule as its own top-level bolded lead in
   group 4**, rather than a nested sub-bullet under the existing
   empty-collection/mutation lead. Rejected: it restates the same epistemic
   position (an empty result proves nothing until shown able to fail) that
   `designer.md`'s "A behavioural assertion whose expected value is an empty
   collection" bullet already states in full; a sub-bullet says only what is
   new — the comparison shape and its mutation form — without duplicating the
   shared reasoning.
6. **Silently correcting T12c's unsatisfiable pinned-count row** rather than
   recording the correction and the coherence-check gap it exposed. Rejected
   per decision (7) and the standing rule (`designer.md`'s set-level bullet,
   `planner.md`'s `## Premise corrections`): an unrecorded correction is
   indistinguishable from a transcription error at review time, and the gap
   in the coherence check itself is worth a future editor knowing about, not
   just the one row it broke.

## Consequences

A future editor extending `designer.md` item 8's group 2 or group 4 checks
this record first for the two carve-outs it leaves standing: `designer.md`'s
`git stash` worked example (currently `:98`) stays #332's to repair, and
`approval-and-audit.md:25` stays byte-exact for #239, with #325 entangled in
the same region. Neither carve-out is this record's to close.

The bolded-lead distribution a future editor of this cluster inherits is
**2/3/2/2/1 = 10** across `designer.md` item 8's five named groups, and
`planner.md` item 12 now carries nine sub-bullets, the last one added for
supplied-control confirmation. Applying ADR-0037's own two-step test (axis
fit, then mirror-vs-capability-cut) is how a future rule decides whether it
extends an existing lead, opens a new sub-bullet, or — only if it opens a
genuinely new axis no existing group name covers — fires the sixth-group
tripwire this record confirmed does not fire today.

**Forward correction:** the 2/3/2/2/1 = 10 figure above is superseded.
ADR-0042 records #367 as a new group-2 lead (2/4/2/2/1 = 11), and its
companion record for #370 records a new group-5 lead (2/4/2/2/2 = 12) — see
those records for the current distribution.

The set-level coherence-check blind spot recorded in decision (7) is not
fixed by this change — only the one row it broke was corrected. A future
change adding a criteria-table coherence check of its own should screen new
prose against the criteria table's own pinned spans, not only against a
fixed list of banned literals, or it can reproduce the same unsatisfiable-row
defect this record documents.
