# 0048. A deleted path is not an exception to `plan-task`'s explicit-pathspec commit rule

- **Status:** accepted
- **Date:** 2026-08-24
- **Issue:** #439

## Context

`plan-task`'s Execution section requires every co-staged task to be committed with **explicit
pathspecs** (`git commit <that task's files>`), so a bare `git commit -a` / `git add -A` can't sweep
a sibling task's staged files into the wrong commit. #439 reported that this rule is "mechanically
impossible to follow for a task that deletes files" and drafted replacement wording: verify the
index, then fall back to committing **bare**. The report's evidence was a pathspec error observed in
construct3-chef#207 — what actually failed there is not reconstructable, since that repo's shell
history is unavailable, so the diagnosis offered for it is inference, not measurement.

The premise itself is checkable independently of that inference, and probing falsified it before any
wording was adopted. On git 2.55.0.windows.4, in throwaway repos, all six deletion scenarios tried —
`git rm` of two files plus a modified third named together in one pathspec commit; a plain `rm` left
unstaged; `rm` followed by `git add -A`; a file committed earlier on the branch then deleted; a
deletion leaving its parent directory empty; and the verbatim construct3-chef#207 invocation (same
filenames, `-F msg.txt`, three pathspecs) — succeeded: exit 0, the correct commit, an unstaged sibling
left untouched. The mechanism is that a pathspec-scoped commit carries `--only` semantics — it commits
each named path's current worktree state, and a deleted file's current state is its absence, not an
error.

Two distinct error strings were measured while probing, and they are easy to conflate: `git add
<path git never knew>` produces `fatal: pathspec 'X' did not match any files` (exit 128), while
`git commit -- <untracked or gitignored path>` produces `error: pathspec 'X' did not match any
file(s) known to git` (exit 1). The string #439's report quoted is `git add`'s — evidence its own
diagnosis named the wrong command as the source of the failure.

Adopting the drafted fallback would have converted a working safety rule into a documented
instruction to do the unsafe thing, in exactly the situation #439 itself calls the most dangerous: a
bare commit at the point where a task has just deleted files is precisely the sibling-sweep the
pathspec rule exists to prevent.

## Decision

**Ship one insertion-only paragraph stating that deletions work, naming both error forms, and
pointing at `git status --porcelain` as the remedy — no fallback, no exception.** Landed in `2d53a94`,
inserted directly after the existing pathspec-discipline paragraph in `plan-task/SKILL.md`'s
Execution section, under label 1 of ADR-0046's four-label regroup (*the index is shared — a
co-staged task's work is entangled with its siblings'*), extending that label's own chain rather than
opening a new one. `git show --numstat 2d53a94` measures **2 insertions, 0 deletions**, one file;
the paragraphs on either side are byte-identical; the section's heading count is unchanged at **12**.
This is ADR-0046's own insertion-only technique — a new paragraph slotted between existing ones with
nothing else touched — applied to a rule inside the label it already governs, not a new regroup.

The remedy the paragraph names is `git status --porcelain`: read the path's actual name and state,
correct the pathspec, and never fall back to a bare commit. A pathspec error is reframed from "this
task deletes files, so the rule doesn't apply" to its actual meaning — the named path is unknown to
git, for one of the two measured reasons above.

**Scope: `plan-task` only, not `commit-changes`.** `commit-changes`'s "stage specific files by name"
guidance is exactly where a `git add <typo>` produces the `fatal:` form this record measured, and it
was weighed as a second home for this same content. Rejected per the repo's cite-don't-restate
convention (#240): stating a rule in two skill bodies is how it drifts when one copy is edited and
the other isn't, and a single canonical statement is easy to point at from anywhere that needs it.
Recorded here explicitly — as a considered-and-rejected alternative with its cost named — so a future
editor encountering the same deletion question from `commit-changes`' side does not re-propose adding
a duplicate paragraph there instead of citing this one.

## Compromise

**What was traded away is a wider guarantee than what was measured.** The probe covers one git
version (2.55.0.windows.4) on one platform (Windows). Older git behaviour for `--only`-semantics
commits against a deleted path is not ruled out by this probe, and the shipped paragraph does not
claim otherwise — it states the mechanism, which is stable across the versions in wide use, but
the record does not assert version-independent verification.

**The alternative rejected was the drafted fallback itself** — verify the index, then commit bare
if a pathspec is rejected. It was rejected outright rather than adopted-with-caveats, because there
is no safe partial version of "commit bare": the whole point of the pathspec rule is to exclude a
sibling task's staged files, and a bare commit at the fallback's trigger point (a task that just
deleted files) is the one moment the rule is guarding hardest.

**`commit-changes` as a second home was rejected on convention grounds, not on the merits of the
content** — see Decision. The honest cost of that rejection is that a reader arriving at
`commit-changes` with exactly #439's question in hand finds no local answer there; the doc doesn't
resolve that today, and it's recorded here as a known gap rather than silently declined.

## Consequences

`plan-task`'s pathspec-commit rule now states, in one place, that a deleted path is not an
exception — closing the reading that #439 opened without adding a second execution path for the
orchestrator to choose between. A future editor auditing the Execution section's label 1 chain for
completeness should find this paragraph already there, and a future editor tempted to add the same
content under `commit-changes` should find the cite-don't-restate rejection recorded above rather
than re-deciding it from scratch.

The inference about construct3-chef#207's actual failure stays unresolved — this record settles only
that the rule *as stated* was not the cause, since the rule already permits what #439 assumed it
forbade. If a mechanism explaining that repo's original error ever surfaces, it belongs in a follow-up
record rather than a rewrite of this one, since this decision's scope is the falsified premise, not
a diagnosis of that incident.
