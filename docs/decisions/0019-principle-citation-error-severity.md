# 0019. Principle-citation findings are `error` severity, deviating from the all-`warning` author-time family

- **Status:** accepted
- **Date:** 2026-07-28
- **Issue:** #170

## Context

`development-principles.md` principles are cited *by number* across skills and
agents (`principle #7`, `` `development-principles.md` #10 ``) — 22 citations
across 13 files. Nothing validated them: not `claude plugin validate`
(frontmatter/schema only), not the test suites, not `audit-conventions`.
Inserting a principle mid-list, or renumbering, silently repoints every
downstream citation to a different principle, with no failure anywhere.

#170 added `lib/principle-citations.mjs`, the second scanner wired directly
into `audit.mjs`'s existing `AUDITING_PLUGIN_SOURCE` block, joining the one
check already there — `readme-inventory`. One further author-time check,
`desc-length`, reaches the same gate by self-gating with an early return rather
than by sitting inside the block. Both are `warning` severity. The new scanner
had to decide whether to match that family's severity or deviate.

**Correction (2026-08-28, #452), in two parts.**

*First:* as originally written, this section and the Compromise bullet below
both named `orphaned-doc` as a member of that author-time family. It is a
member in neither respect: `scanOrphanedDocs` is invoked outside the gate
block, alongside the other hygiene scanners, and emits `info` rather than
`warning` — so it renders under `### Info (optional)` and **can** fire in a
consumer's audit, against that consumer's own `docs/` tree. The claim was
defective from the start rather than decayed: the check has a single authoring
commit (2026-07-20, eight days before this record), and it was already ungated
and `info` there.

*Second:* the first pass at this correction replaced one membership error with
another, describing `desc-length` as sitting "in that block". It does not —
`evaluateDescriptionLengths` is called before the block opens and self-gates
with an early `AUDITING_PLUGIN_SOURCE` return. That is exactly the reading the
companion correction in ADR-0047 warns against, reproduced in the act of fixing
its sibling, which is worth recording: the gate is enforced at two layers, and
"is the call inside the `if`?" answers only one of them.

The decision below is unaffected by either part — only this background
enumeration was wrong. See ADR-0049 for the current classification of every
check.

## Decision

**`error` severity**, deviating from the all-`warning` author-time family.

A mis-pointed citation is a functional regression in agent behavior, not a
doc-tidiness gap: the citing skill or agent's guidance now points at the wrong
principle, silently, with the reader none the wiser. `hasErrors` counts
`error`-severity findings only (`audit.mjs`'s `hasErrors`); a `warning` finding never
moves the exit code. Making this check `warning` would mean enforcement rests
entirely on someone reading the Warnings section by hand — precisely the
discipline gap that let the #167 backstop-guard issue through in the first
place (see `CLAUDE.md`'s "Read the audit's Warnings section explicitly"
callout).

What makes `error` safe here, unlike a blanket policy of promoting every new
check to `error`: the scanner is gated inside the existing
`AUDITING_PLUGIN_SOURCE` block, so it can only ever fire when the audit is run
against this plugin's own source tree — never in a consuming repo's audit. An
`error` here breaks exactly the build it's meant to break
(`commands.validate` chains the audit, so a bad citation fails CI for this
repo) with zero consumer-facing blast radius.

A related design point worth recording alongside the severity choice: when
`parsePrincipleNumbers` yields an empty set, the scanner emits **one**
parse-failure finding, not one per citation. An empty parsed set means the
parse itself broke (the doc's list shape changed), not that all 22 citations
went bad simultaneously — one-per-citation in that case would flood the report
with a misleading finding count and obscure the actual root cause.

## Compromise

Alternatives rejected:

- **`warning`, for family consistency with `readme-inventory` /
  `desc-length`.** *(As written this bullet also listed `orphaned-doc`; see the
  correction in Context above — 2026-08-28, #452.)* Rejected as unenforced:
  warnings don't move the exit code, so the whole point of the check — catching a silent repoint before it
  ships — would depend on a human reading the Warnings section rather than on
  the build failing.
- **`warning` now, `error` later once the check has proven itself.** Rejected
  as a deferred-cost path: it buys nothing (the check's logic is identical
  either way) at the cost of a second PR plus a window where the exact gap
  this check exists to close stays unenforced.

## Consequences

A bad principle citation in `plugin/**/*.md` fails `node
plugin/skills/audit-conventions/scripts/audit.mjs` (and therefore
`commands.validate`) for this repo, the same way a missing required
`metadata.expects` file does.

**A worked example of a *bad* citation cannot be written anywhere under
`plugin/`.** This bit immediately: the first draft of this feature's own
`SKILL.md` paragraph used `principle #99` to illustrate what the check catches,
and the scanner correctly failed the build. The obvious escape hatch —
masking inline code spans before matching, as `hygiene.mjs`'s `maskInlineCode`
does for links — is **not available here**, because the real citation form
`` (`development-principles.md` #11) `` puts the number *outside* the backtick
span; masking would blank the anchoring keyword and stop detecting two genuine
citations in `ts-implementer.md`. The constraint is inherent to keyword-anchored
matching, not a bug to fix. Describe the failure mode in prose instead of
illustrating it with a live number.

A future maintainer adding a fifth author-time
content scanner should treat severity as a per-check decision on the merits
(does an unenforced `warning` leave a real gap, and is the check's blast
radius genuinely confined to this repo?), not default to matching the
existing `warning` family for consistency's sake.
