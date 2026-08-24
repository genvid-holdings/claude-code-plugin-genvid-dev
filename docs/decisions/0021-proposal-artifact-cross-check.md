# 0021. Proposal-vs-artifact cross-check gate

- **Status:** accepted
- **Date:** 2026-07-29
- **Issue:** #180

## Context

`plan-task`'s full-proposal shortcut adopts an issue body as the requirements
doc. Its verification gates all asked whether the work was *real and
unbuilt* — feature-already-shipped, bug-symptom-observable,
dependency-already-resolved, mechanism-presence, mechanism-supersession,
pattern-divergence. None asked the prior question: is the proposal's
factual content actually **correct about the artifact it modifies**?

Motivating case: `gvt-construct3#59` — a doc issue proposed a JSON shape as
a **map**; the target doc documented that same shape as an **array** roughly
twenty lines above where the new text would land. Applying the proposal
verbatim would have produced a doc contradicting itself inside one section.
It was caught by `triage-issues`, not `plan-task` — i.e. by luck. Resolving
against the authoritative reference showed the *proposal* was right and the
shipped doc had been wrong since it was written.

Corroborating evidence: in a single triage batch on 2026-07-29, three of
eight issues (#184, #186, #188) turned out to be written against a stale or
wrong reading of their target. #184 proposed wording for a passage that no
longer existed, whose shipped replacement was already *stricter* — verbatim
adoption would have been a regression. #186's premise was already covered
elsewhere in the target doc. #188 targeted a hook the plugin doesn't ship
and misdiagnosed it. None of these would have been caught by the
already-real-and-unbuilt gates alone.

## Decision

A new principle, `development-principles.md` #13, carries the durable rule:
a proposal is a claim about the artifact it modifies, and that claim is
verified — not transcribed — before it's adopted as a requirements doc. Both
conflict directions are live outcomes (the proposal may be stale/wrong, or
the artifact may have been wrong since it was written), so neither side is
trusted by default. When a conflict surfaces, the source that settles it is
named — an external spec, git history, or the artifact's own provenance —
and correcting a wrong artifact is in scope for the same change. With no
arbiter available, the conflict is surfaced at the user checkpoint as an
explicit fork rather than silently resolved either way.

This fits the existing pipeline architecture at two points rather than one:
`plan-task` cites and repeats the principle at **both** entry points where a
proposal's claims get adopted — the full-proposal shortcut (the
requirements-adoption bullet list under `## Shortcuts`) and the Phase 1
analysis path (the feature/bug gate cluster, just before the Phase 1
checkpoint) — since the shortcut is one path
into requirements-gathering, not the only one, and Phase 1 has the identical
exposure whenever `plan-task` is invoked directly on an untriaged issue. A
corresponding line was added to `approval-and-audit.md`'s Self-Audit
Checklist, so a plan is checked for this before it reaches the user, not
just guarded at intake.

Choosing a shared principle over a `plan-task`-local check is itself an
application of the repo's established **cite-and-repeat** pattern (see
`SKILL.md`'s optional-DRY-item paragraph, and #167): an agent dispatched
standalone may never load `plan-task`'s own body, so the rule needs a home
citable from other surfaces later, not just inline prose in one skill.

**Relationship to principle #12.** #12 ("a pointer is a claim about its
target") is *writing-side* — every clause positions the reader as the
*author* of a claim ("before writing the pointer," "while editing *only*
the source side"), and its remedy presumes ownership of the source with the
ability to edit the target. #13 is its consuming-side mirror: verifying a
target before **adopting an incoming claim** about it, where the claim
arrives from someone else (an issue author) rather than being authored in
the same edit. That asymmetry — author-side vs. consumer-side verification
— is why #13 is a new principle rather than an amendment folded into #12.

## Compromise

Two alternatives were considered and rejected, plus two surfaces that carry
a related half-implementation and were deliberately left out of scope.

**Rejected: a `plan-task`-local gate, no shared principle.** Simpler and
faster to land, but breaks the repo's cite-and-repeat convention — the rule
would exist only inside one skill's prose, uncitable from `designer.md`,
`analyst.md`, or any future surface that develops the same need.

**Rejected: artifact-wins-by-default when no arbiter exists.** The
simplest default, and usually the safer bias in isolation. Rejected because
it is exactly the bias the issue warns against, and it would have gotten
the motivating case **backwards** — in `gvt-construct3#59` the proposal was
right and the artifact was the one that had been wrong since it was
written. A default that always favors the artifact silently reproduces
that outcome the next time the roles are reversed.

**Rejected: always require an external source before proceeding.** Clean
in principle, but stalls exactly where it's needed most: many conflicts
have no external spec, and git history or the file's own provenance is the
only available ground truth. Requiring a source that doesn't exist blocks
progress rather than routing the decision to the user.

**Scoped out: `triage-issues` / `issue-triage-analyst`.** Triage is what
actually caught the motivating case, but #180 argues explicitly that the
gate belongs in `plan-task`, "where the shortcut's assumption actually
lives" — the dependency on triage catching this is luck, since `plan-task`
is routinely invoked directly on an untriaged issue. Making triage's catch
reliable, rather than incidental, is a plausible follow-up, not this
change.

**Scoped out: `designer.md` / `analyst.md`.** These two agents already
carry the two *half*-implementations of this rule, split across files:
designer.md's "Run the footprint audit when the design removes or renames a
shared symbol" item ("don't trust the analyst's narrative summary — grep the
codebase") and `analyst.md:60` ("do not treat the committed copy as ground
truth"). Mirroring #13 into both agents explicitly would unify the halves,
but exceeds #180's ask; the shared principle is citable from them later if
that unification becomes its own change.

## Consequences

Every full-proposal `plan-task` run now owes a read of the target artifact
before adopting the proposal's claims as requirements — real added friction
on a shortcut whose entire premise is skipping the analyst for speed. The
corroborating evidence is the offsetting case for that cost: in one triage
batch, 3 of 8 issues (#184, #186, #188) were written against a stale or
wrong reading of their target, each a case this gate would have caught
directly rather than by luck.

The gate also found drift in **#180's own body**: the issue claimed the
shortcut's verification bullet — the bullet whose mechanism-presence check
"sits alongside the unbuilt gate," before this change shifted it — listed
"exactly the four gates," naming
mechanism-superseded as the fourth. The actual four are
feature-already-shipped/bug-symptom-observable (the unbuilt gate),
mechanism-presence, mechanism-supersession, and pattern-divergence. Minor,
and it didn't change the ask, but it's a live instance of the gate working
on the issue that introduced it.

Watch for: the two half-implementations in `designer.md`/`analyst.md`
diverging further from #13's fuller statement over time, since they were
deliberately left unmirrored rather than unified.
