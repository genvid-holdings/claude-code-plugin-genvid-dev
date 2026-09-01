# 0050. `designer.md` item 8 group 2 gains a fifth lead for self-referential criteria (#452), mirrored in `planner.md` item 12; ADR-0037's tripwire holds

- **Status:** accepted
- **Date:** 2026-09-01
- **Issue:** #452

## Context

A retro on #452's planning run found a criteria defect with no existing rule against it. Two pledged
acceptance-criteria rows were broken because **their corpus contained their own text**: each asserted a count
over the issue body, and ADR-0017 puts the acceptance checklist *in* that body. A zero-hit half then cannot
pass, because the row must quote the token it bans in order to state its check; a positive half is vacuous for
the mirror reason, matching its own quotation whether or not the artifact was ever corrected. Both fail
silently and in opposite directions — the first reads as unfinished work, the second as a green check.

The defect is not exotic. Every row whose corpus is the issue body is self-referential by construction, so the
population is "all body-scoped rows", not "rows that happen to mention their own token".

`designer.md` item 8 group 2 — *Is the expected value right?* — already carried four leads when this was
found, and one of them is close enough to require an explicit determination rather than an assumption:
**satisfiable-alongside-the-change's-own-deliverable**. It governs a row whose expected value collides with
prose the change itself writes. That is adjacent but not the same population: it fires when the *deliverable*
names the measured token, and stays silent when the *criterion* does. The designer authored one of the two
broken rows with that lead in force, which is the evidence it does not reach this case.

ADR-0042's Consequences leave a standing directive for exactly this moment: *"A future editor adding a rule to
group 2 checks this record's four entries first for what is already owned."* This record discharges that check.

## Decision

**Add a fifth bolded lead to group 2, not a sixth group.** ADR-0037's tripwire asks whether a new rule fits an
existing group's axis or opens a new one. Group 2's axis is *Is the expected value right?* — and a row that can
never reach its expected value, or reaches it regardless of the work, is a defect in exactly that axis. It
extends the axis rather than opening one, so the tripwire does not fire.

The lead states the shape, both failure directions, and the remedy: **anchor at line start to the line shape
the defect occupies**, since checklist rows all begin with a list marker and a checkbox, so a pattern that
cannot match that prefix stays falsifiable. The `^` is called out as load-bearing — an unanchored pattern still
matches inside the row that quotes it, which reproduces both failures from a row that looks compliant.

**Mirror it in `planner.md` item 12.** Per ADR-0035 and ADR-0045 each designer criteria rule's planner mirror
is an explicit decision rather than a default. Here the mirror is not optional, because **the planner is the
agent that creates the defect's corpus**: the designer authors rows against a body that does not yet hold the
checklist, and `plan-task` Phase 4 splices it in afterwards. So a row the designer verified as sound can become
unsatisfiable at transcription time, and only the planner is positioned to see it.

The mirror also names a specific interaction the designer side cannot: item 10's premise-correction sub-bullet
instructs the planner to state a decayed row's **original expectation**, which necessarily reproduces the
literal a zero-hit row bans. That instruction is how one of the two #452 rows was shipped. The mirror directs
the original expectation into a note *outside* the criterion row.

**Verification is against a corpus that contains the row.** The rule's first draft told the author to check the
anchor against the pre-change body and the corrected one. Neither holds the checklist, so both report a clean
pass on a row that cannot survive the splice — a verification step structurally unable to detect the defect its
own rule exists to prevent. Corrected to: test against the post-splice body, or, at design time, against the
row's own text pasted in as a synthetic extra line.

## Compromise

**Rejected: extending the satisfiable-alongside lead instead of adding a fifth.** It is the nearest neighbour,
and folding in would keep group 2 at four. Rejected because the two have different trigger conditions and
different remedies — that lead's remedies are a floor over a measured baseline or a content anchor, while this
one's is a structural line-start anchor — and because merging them would bury the population statement ("every
body-scoped row") inside a lead about deliverable collisions, where a reader checking their own row against it
would not look.

**Rejected: firing ADR-0037's sixth-group tripwire.** The axis test resolves cleanly to group 2's own question,
so minting a group would fragment an axis rather than separate two.

**Accepted cost: group 2 now carries five leads.** ADR-0042 recorded the group at four and noted the count as
something a future editor should weigh. Five is a real increase in a group that is already the largest, and the
counter-argument — that the group is becoming a catch-all for criteria defects — is not baseless. It is
accepted here because every one of the five answers the same question about a row, and because the alternative
on offer was a merge that would have hidden the new rule rather than a genuinely different home.

## Consequences

- Group 2's leads go from four to five. A future editor adding a sixth checks all five for what is already
  owned, and should weigh whether the group has stopped being an axis and started being a bucket — that
  judgement is closer now than when ADR-0042 recorded it.
- The planner mirror means a body-scoped row is checked twice, once at authoring and once at transcription,
  against different corpora. That redundancy is deliberate: the corpora genuinely differ, and only the second
  one contains the row.
- `build-probe` gained a related rule in the same change — a mutation probe must be contained, since it is the
  one probe that cannot live in the scratchpad — recorded here only as context, not as a group-2 matter.
- **A number reserved in an issue body is a soft reservation and this record consumed one.** #440's R4 had been
  re-pointed at `0050-*.md` days earlier; this record took that number, so R4 was re-expressed to glob no
  number at all rather than be chased a second time. Prefer number-free criteria for a record that does not yet
  exist.
- **Where a new bullet is inserted in an agent file is a ratchet question, not only an editorial one.** The
  planner mirror was first placed above three lines that `.pointer-baseline.json` cites by number, which
  shifted them and re-fired six accepted-debt entries at `error` severity across four citing files — a red
  build produced entirely by insertion position, with no citation actually wrong. The remedy taken was to move
  the new bullet *below* the cited lines, which is also its better semantic home; the alternative, re-taking
  the baseline, would have spent accepted debt to buy nothing. **Prefer appending below a cited span to
  re-taking the ratchet.** ADR-0047 records why the ratchet exists; this is what it feels like from the
  authoring side.
