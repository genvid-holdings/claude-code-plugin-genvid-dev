# 0047. Positional pointers are checked for a content anchor, at `error` severity behind the audited-repo gate, ratcheted by a repo-private baseline

- **Status:** accepted
- **Date:** 2026-08-24
- **Issue:** #406

## Context

This repo's prose and code comments cite each other *positionally* — a path, a colon, a line number. Nothing
checked those citations. When a cited target gains a line above the cited one, the citation keeps rendering
exactly as it did before, so the decay is **silent by construction**: a reader follows the pointer, lands on
unrelated text, and gets no signal that the claim ever pointed elsewhere. The four pre-existing author-time
content scanners (`readme-inventory`, `desc-length`, `orphaned-doc`, `principle-citations`) covered index rows,
description length and principle numbers — nothing covered the single most decay-prone claim shape the repo
writes.

The convention itself was already settled and recorded twice. ADR-0037 decision (4) established *re-anchor
first, insert second*, converting nine line-number references into quoted-text anchors before the insertion
that would have decayed them; ADR-0042 records the same remedy on the criteria-authoring side — a positional
anchor is repaired not by correcting the number but by **re-expression against a content anchor the row
re-derives**. Both are development principle #12 applied. What was missing was enforcement: an unenforced
convention that fails silently is indistinguishable from no convention, and the corpus had accumulated
pointers accordingly.

ADR-0019 left a standing directive for exactly this moment: a fifth author-time content scanner must decide
its severity *on the merits* — asking whether an unenforced `warning` leaves a real gap, and whether the
check's blast radius is genuinely confined to this repo — rather than defaulting to the `warning` family for
consistency's sake. This record answers both, and the second answer does not come out the way ADR-0019's did.

## Decision

**(1) The check asks whether a pointer carries a content anchor and whether that anchor is where the pointer
says — not whether the line number is in range.** #406 originally specified a checker reporting "a pointer
whose line exceeds the target's length" and "a pointer whose line does not contain the quoted span," graded by
catching five known-stale citations. As written that was **provably unsatisfiable**, and the measurements are
the reason:

- **Zero pointers are out of range.** Re-measured this run against the current tree: of 107 pointers that
  resolve to exactly one target, **0** name a line beyond that target's length. In a repo whose files only
  grow, range-checking is structurally almost dead — the decay mode is a *shifted* line, not a *missing* one.
- **Four of the five original controls carry no quoted span at all.** The citing prose makes a claim *about*
  the target rather than quoting it, so a "line does not contain the quoted span" check has nothing to
  compare. Measured yield of the three originally sketched checks against those five controls: **1**.

So the checker's primary finding is `pointer-anchor-missing` — a pointer written with no re-derivable anchor
after it — with `pointer-anchor-drift` (the anchor is real but lives on a different line, which the finding
names) and `pointer-anchor-broken` (the anchor is absent from the target entirely) covering the pointers that
are provably wrong. This is not new policy. It makes ADR-0037's and ADR-0042's existing convention
*enforceable*, which is the whole delta.

**(2) `error` severity, inside the existing `AUDITING_PLUGIN_SOURCE` gate — and ADR-0019's safety argument
does not transfer.** ADR-0019's two questions, answered:

*Does an unenforced `warning` leave a real gap?* Yes. `audit.mjs`'s `hasErrors` counts `error`-severity
findings only, so a `warning` never moves the exit code and enforcement would rest entirely on someone reading
the Warnings section by hand — which is precisely the discipline gap this check exists to close, applied to a
failure mode that is *already* invisible without the tool. And the ratchet below only ratchets if
non-conformance blocks: a baseline paired with a `warning` accepts debt against a gate that was never shut.

*Is the blast radius confined to this repo?* Yes — **but for a different reason than ADR-0019's, and that
difference is the most consequential thing in this record.** `principle-citations` is scoped to `plugin/`, so
it is *inherently* un-runnable against a consuming repo: even ungated it would find nothing there, because a
consumer has no `plugin/` tree. This scanner's citing corpus reaches the repo-root `docs/` tree, **including
`docs/decisions/`, which consuming repos also have** — `create-adr` scaffolds it. Ungated, this check would
impose the content-anchor convention on every consumer's ADRs and fail their `commands.validate` over prose
the plugin does not own. What makes `error` safe here is therefore **the gate itself**, not the scanner's
reach — and the gate is safe because `AUDITING_PLUGIN_SOURCE` is derived from the **audited** repo's path, so
inside the block a repo-root `docs/decisions/` can only ever mean this repo's own records. Anyone reasoning
from ADR-0019 that "an author-time scanner is naturally confined" would reach the wrong conclusion here.

**(3) Corpus: `.md` and `.mjs` under the repo-root `docs/` and `plugin/` trees plus the repo root's own
*git-tracked* files, excluding `audit-conventions-evals/` — and `plugin/CHANGELOG.md` is deliberately
*included*.** That last clause diverges from `principle-citations`, whose corpus explicitly filters the
changelog out. The reason is a positive control: release-note prose cites agent bodies by line, and one such
pointer occurs nowhere else in the repo —

```
plugin/CHANGELOG.md cites `designer.md:79`
  — the only occurrence of this pointer in the repo
  — excluding CHANGELOG would make the control that grades it vacuously true
```

A control that can only pass is not a control. `audit-conventions-evals/` is excluded for the opposite
reason: its fixture consuming-repos carry contract filenames (`CLAUDE.md`, `docs/TOC.md`, …), and counting
them as resolution candidates would turn correct, unambiguous citations of the real files into ambiguity
findings. `.json` is deliberately not a citing type, so recording a pointer in the baseline cannot mint a new
one and the baseline cannot scan itself.

**The repo root was added to the citing corpus after this record was first written, and *tracked* is the
load-bearing word rather than a hygiene preference.** `CLAUDE.md` is the repo's densest prose about its own
internals and cited a moved line, so a corpus stopping at the two trees left the most-read document in the
repo unchecked. But the root is also where gitignored working artifacts land, and admitting one would break
the ratchet from both ends at once: the transient planning document present when this landed carried eleven
pointers, and a working document written *while repairing pointers* cites precisely the strings the guard test
forbids the baseline from ever holding. Its findings could therefore be neither fixed — the artifact is not
the branch's to edit, and no other developer has it — nor accepted. Unresolvable by construction. So the root
half of the corpus is scoped by `git ls-files`, and only the root's own entries are listed, never a walk from
it, since both trees above are already walked whole. A later refactor that swaps the tracked-file check for a
plain directory listing reopens that trap silently, and the tell — a finding on a file no one else has —
appears only on the machine that hits it.

**The anchor grammar admits a hyphen inside a backticked identifier.** Kebab-case skill and agent names and
hyphenated filenames are this corpus's most common backticked spans, and banning the hyphen rejected all of
them as anchors while the convention was asking authors to write exactly that shape. The measured delta on the
current corpus is **zero** — no pointer here is followed by a hyphenated span — so this is forward-looking
rather than a fix. The hyphen was never part of the identifier constraint's defence and cannot reintroduce
the sibling-pointer artifact that constraint exists to exclude: a sibling pointer needs a colon, which the
pattern still refuses, alongside whitespace and a slash.

**(4) The ratchet: `.pointer-baseline.json` at the repo root, keyed by citing file + pointer text +
occurrence, with a digest of the cited target range.** Three properties, each chosen against a specific
failure:

- **Repo root, not under `plugin/`.** `plugin/` is the published git-subdir; which of *this* repo's citations
  are accepted debt is a repo-private fact and must not travel to consumers.
- **The citing file's line number is deliberately absent from the key.** An accepted pointer must survive its
  own document being renumbered — inserting a paragraph above a baselined citation moves it without changing
  anything about the claim it makes. Keying on it would re-fire the whole ratchet on every edit, which is
  exactly the decay this tool exists to catch elsewhere.
- **Each entry carries a digest of the cited target range**, so acceptance means "this pointer, against *this
  content*" rather than "this pointer, forever". Rewrite the target under an accepted pointer and the entry
  re-fires — even when no anchor broke, and even for a pointer carrying no anchor to break.

**Absence of the baseline is the loud state.** With no baseline file every non-conforming pointer reports, so
red is reached by doing nothing; an unreadable or malformed baseline is treated identically, so a corrupt
ratchet suppresses nothing rather than silently accepting everything. The generator is **prune-only by
default** — a wholesale regeneration would silently re-accept every finding introduced since the last run, so
accepting new debt is a separate, explicit act — and `--accept-new` refuses outright, with a non-zero exit and
no write, while any provably-wrong pointer exists.

**(5) Point-in-time evidence.** The scanner was verified against the **unfixed** tree, with no baseline file
present, before any pointer was swept. The repo squash-merges, so this transition cannot be reconstructed
after merge; this record and the PR body are its two durable homes.

```
commit bebfea9 — .pointer-baseline.json absent — audit exit 1
138 findings: 103 anchor-missing, 20 orphan-continuation, 12 ambiguous, 3 drift

all 9 independently-established stale pointers REPORTED
  (3 as drift naming corrected lines 60 / 101 / 864; 6 as anchor-missing)
positive control: all 7 verified-live pointers clean — 0 drift/broken hits each
```

The nine were established by **hand-reading their target lines**, not by the tool — the tool's output cannot
be its own ground truth. The seven-pointer positive control is what carries the weight: it shows the
classifier *discriminates* rather than flagging everything it sees, which a red-only run could never
establish.

## Compromise

**A markdown AST library was rejected, and the reason is architectural rather than a line count.** remark
would have removed perhaps 40–60 lines of line-by-line scanning — and none of the anchor grammar, the path
resolver, the anchor verifier, or the ratchet, which is where essentially all the logic lives. Against that
modest saving: this repo has **no `package.json` and no npm at all**, and ships as a git-subdir plugin that
consumers install with no npm step. Adding a dependency would mean introducing a dependency *system* to a
project that has deliberately never had one, and imposing it on every consumer's install path. All four
pre-existing content scanners are hand-rolled for the same reason; this one matches them.

**Inferring an anchor by proximity was implemented and measured during design, then discarded.** The
attractive version of this check reads whatever text sits near a pointer and treats it as the anchor. Measured
against the real corpus, that grammar produced roughly **40 artifact anchors out of 49 classifications** —
connective fragments like `" and "` — and, worse, **false-passed two genuinely stale pointers**, which is the
failure direction that matters: a checker that green-lights decayed citations is worse than none. The root
cause is structural, not tunable: a pointer normally sits *inside* a backtick span, so a proximity grammar
consumes the pointer's own closing backtick as the anchor's opening delimiter and reads the connective prose
after it as quoted target text. Parsing the pointer **together with its enclosing delimiters** — recording
where the delimiter ends, not where the digits end — eliminates the entire class rather than shrinking it.
(These proximity figures are carried from the design-time probe and were not re-derived in this run; the
out-of-range and current-corpus counts above were.)

**The `--accept-new` refusal has an honest gap, accepted deliberately.** It blocks on `pointer-anchor-drift`
and `pointer-anchor-broken` — the two kinds that mean a citation is *provably wrong* — and baselining a
known-wrong pointer would undercut the tool's own premise. It does **not** cover `pointer-anchor-missing`, so
a newly added unanchored pointer can still be swept into the baseline without complaint. Making the refusal
cover it was rejected because `anchor-missing` is the bulk state of the pre-existing corpus, and a gate that
refuses the thing it is being run to accept is unusable. The defence is placed elsewhere instead: a separate
guard test pins the specific swept pointers that must never re-enter the baseline. That is narrower than a
general rule, and it is recorded here as a known limit rather than presented as covered.

**Verifying *anchor-only* references was measured and deliberately deferred, and this is the gap most likely
to be mistaken for a guarantee.** The renumber-proof shape the Consequences section recommends is, by the
grammar, not a pointer at all: with no line number nothing resolves, so the quoted anchor is never compared
against the named file. Closing that — resolving a reference that names a file and quotes a span but gives no
line — is buildable on the machinery already here, so it was priced against the current corpus rather than
argued about:

```
53 anchor-only references in the corpus
  31 resolve to exactly one target
    30 verify clean
     1 false positive
```

That single case is the entire reason the gap stays open, and it is a *class* rather than an accident:
ADR-0045 quotes an issue's own characterisation of `plan-task/SKILL.md` — reported speech *about* the file,
not a quotation *from* it — so the quoted words correctly appear nowhere in the target, and a checker cannot
tell the two apart without reading intent. The check as it stands would therefore yield **zero true findings
and one false one**, which is the wrong side of the ledger for a scanner running at `error`; a false red on
correct prose is the failure direction this record has already refused once, in rejecting the proximity
grammar. Anyone implementing it should handle the reported-speech class first — an explicit opt-out marker, or
a grammar that treats a quotation as an anchor only where the citing sentence asserts the target contains it —
rather than starting from the resolver. (The four figures were measured on the current corpus during this
branch's follow-up probe and are point-in-time; the reported-speech case was separately confirmed by hand
against the target.)

**The `scanBrokenLinks` migration onto the shared fence-aware iterator was deferred past the red-proof
commit.** Doing it earlier would have shifted `hygiene.mjs`'s `DEFAULT_EXCLUDE_PATHS` declaration off the line
two ADRs cited live — a line serving as a positive control graded at that very commit. Moving a control's
target at the commit that grades it falsifies the grading, so the refactor waited until the grading was
captured. It has since landed: the declaration did move (18 to 19), and both citations were **de-pointed** in
the same commit, keeping their `DEFAULT_EXCLUDE_PATHS` anchors and dropping only the fragile number. The
ordering is ADR-0037 decision (4)'s discipline reused — re-anchor first, move second — so no commit in this
branch's history carries a citation this refactor decayed.

## Consequences

**Red is the default, and the baseline is now a maintained artifact.** A new pointer written without an anchor
fails `commands.validate` for this repo. The renumber-proof shape is still the one to reach for: name the file
with a backticked identifier or quoted span and **no line number at all**. State its guarantee precisely,
though — the grammar recognises a pointer only where a line number appears, so a reference without one is not
a pointer, produces no finding, and is **never resolved against its target**. It therefore cannot decay from
renumbering, which is the failure mode this scan exists for; but its anchor text is unchecked, and a quoted
span appearing nowhere in the named file passes silently. The shape trades a verified-but-fragile citation for
an unverified-but-stable one. That is a deliberate trade — see the Compromise section's measurement — and it
does not change the recommendation. Where a line number genuinely helps, it must be followed immediately by a
span that really appears there.

**This record's own text was written under the check it documents.** Every stale pointer quoted above sits
inside a fenced block, because the scanner skips fences and a live example would otherwise become a real
finding — one that could not be baselined either, since the guard test forbids exactly those strings from
entering the baseline. Future records citing decayed pointers as examples inherit that constraint.

**`principle-citations` is the natural next migration target.** It still carries its own inline fence loop
rather than the shared iterator, now that `scanBrokenLinks` and the pointer scanner both use it. Two of the
three content scanners share one fence implementation; the third does not.

**The gate argument is now load-bearing in a way ADR-0019's was not, and must be re-checked if the corpus
changes.** ADR-0019's scanner would be harmless even ungated. This one would not. Any future widening of the
citing corpus — or any change that makes the check runnable outside `AUDITING_PLUGIN_SOURCE` — reopens the
severity question rather than inheriting the answer recorded here. The repo-root widening in decision (3) is
the first such case and was re-checked rather than waved through: it adds only files at *this* repo's root,
which the path-derived gate already confines, so the answer holds — but it holds because it was re-asked.

**ADR-0019's standing directive is discharged.** The fifth author-time content scanner decided severity on the
merits, and reached the same verdict by a different route. That the *route* differed is itself the lesson: the
directive's second question is not a formality, and a future sixth scanner should expect its answer to be
specific to that scanner's reach rather than to the family's habit.
