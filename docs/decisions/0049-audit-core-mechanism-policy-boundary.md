# 0049. The shared audit core is bounded by plugin-blind decidability: contract ratified, mechanism shareable, policy never

- **Status:** accepted
- **Date:** 2026-08-28
- **Issue:** #452

## Context

Two plugins in the `gvt-plugins` catalog ship an audit skill — this repo's `audit-conventions` and
`gvt-construct3`'s `audit-c3-conventions` — and a third is proposed. They already share code, by copy-paste,
with nothing keeping the copies honest. #452 asked what the common core actually *is*, so it can be provided
once instead of forked three ways.

This record answers that question — it fixes the **mechanism/policy** boundary for a shared audit core — and
**ships no code**. It is link 1 of a chain: #456 overturns or upholds
ADR-0047's npm rejection, #457 publishes the tool, #458 and #459 rewire the two consumers, #460 mirrors the
duplicated modules' tests. Deciding the boundary before writing the tool is the whole point — a shared module
extracted without one converges on the shape of whichever caller was loudest.

**The leak is already visible, which is why this is urgent rather than tidy.** `lib/path-overrides.mjs`
declares:

```js
export const RESERVED_PATH_KEYS = ['plugin_root', 'c3project'];
```

with a comment describing `c3project` as a "legacy genvid-construct3 marker". A sibling plugin's policy
literal already sits inside one of this repo's supposedly plugin-neutral modules. A selector-shaped shared
interface is that leak, generalised and institutionalised.

## Decision

### The discriminator

**A capability belongs in the shared tool if and only if its correctness is decidable without knowing which
plugin is asking.** Anything whose correctness depends on the identity of the repo under audit, or on who is
running the audit, is policy and stays with the plugin.

Every decision below is this rule applied. Where the answer is uncomfortable — the tally, the author-time
gate, hygiene — the discomfort is the rule working, not an exception to it.

### Three categories, not #452's two

#452 framed the split as a **mechanism/policy** dichotomy. There is a third category, and separating it is
what makes anything shippable today: a **contract** that is shared and normative but carries no code.

**Contract — shared, normative, no code.** The finding record shape; the exit-code contract; the
`metadata.expects` grammar (the `files` / `config` / `tools` sections, the `required = entry.required !== false`
default, and the `severity: required ? 'error' : 'info'` mapping); and Anthropic's plugin layout
(`skills/*/SKILL.md`, `agents/*.md`), which neither plugin owns and neither may redefine. This is the only
part the two independent implementations *already* agree on, which is precisely why it is ratifiable now, with
nothing moved and no release coupling.

**Mechanism — shared, executable, plugin-blind.** `extractFrontmatter`; `resolveKey`; `walkComponents` and
`loadComponent`; `fileExists` / `dirExists` / `commandExists`; and the **evaluation half** of `evaluateFile`,
`evaluateConfig` and `evaluateTool`.

That last item is the subtle one: **the boundary runs *inside* those three functions.** Path *resolution*
diverges between the two plugins and neither flavour exists in the other — this repo resolves through a
trailing-slash directory convention plus `paths` overrides (`resolveExpectationPath`), while `gvt-construct3`
re-roots on a per-entry `base: 'project'` marker. Resolution is therefore a **policy hook the plugin supplies**;
evaluation — does the resolved thing exist, what finding does that produce — is mechanism.

**Policy — per-plugin, never shared.** Expectation declarations; the path-resolution flavour above; the tally
formula; report rendering; hygiene scanning and its lists; the legacy/migration state machines; and the
author-time gate.

### The tally is not shared, and the tool emits none

The two tally formulas are not two implementations of one idea — **they measure different things.**

This repo's `summarizeExpectations` buckets on each finding's own `required` boolean — *declared* optionality
— and its own comment records that a finding whose `required` is neither strictly `true` nor `false` is
ignored by both buckets. Every self-contained and hygiene finding therefore sits outside the tally entirely.
`gvt-construct3` instead computes `requiredTotal` as the count of findings that are either satisfied or
`error`-severity — *observed* severity — with a comment stating that warnings are advisory and excluded from
the denominator.

**Decision: the shared tool emits no tally at all.** Each plugin computes its own from the findings it holds.

This is deliberately stronger than #452's fallback of "shared, or else selectable". A selector is a policy
enum living inside the tool — the `RESERVED_PATH_KEYS` leak, promoted to an API — and with a third audit
arriving the tool becomes a registry of its own callers.

**One consequence binds the contract below:** this repo's formula reads `finding.required`, so keeping the
tally on the policy side is only possible if `required` is in the wire shape. The tally incompatibility and the
record-shape divergence are the same fact seen twice.

### The author-time gate is not delegable

#452 described the gate's derivation as `relative(REPO_ROOT, PLUGIN_ROOT)`. It is in fact a **predicate over**
that value — `rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))`, i.e. *is `PLUGIN_ROOT` at or inside
`REPO_ROOT`?* — and `PLUGIN_ROOT` is itself derived from `import.meta.url`. **Both halves break when the code
is invoked from a package cache rather than from the tree it is auditing**, not only the half #452 named.

**The failure mode reads as fail-safe and is the opposite.** `AUDITING_PLUGIN_SOURCE` fails **closed**:
`principle-citation` and the `pointer-*` checks — both **`error` severity** — simply stop firing. Nothing is
reported. A red build turns green, silently.

**Decision: the gate stays plugin-side, and the general rule is that the tool never owns a check whose
severity argument depends on who is running it.**

An `--author-time` flag was considered and is **rejected**: a flag is assertable by anyone, so a consumer's CI
copying a command line would get `error`-severity anchor findings against ADRs the plugin does not own — which
is exactly what ADR-0047 forbids.

**The gated set, corrected in both directions.** #452's enumeration was wrong twice over. Verified against
this repo's current tree:

| Check | Severity | Behind `AUDITING_PLUGIN_SOURCE`? |
|---|---|---|
| `readme-inventory` | warning | yes (call site) |
| `desc-length` | warning | yes (inside the evaluator) |
| `pillar-unknown` | warning | yes (inside the evaluator) |
| `principle-citation` | **error** | yes (call site) |
| `pointer-*` (eight kinds) | **error** | yes (call site) |
| `retired-token` | info | **no** |
| `broken-link` | warning | **no** |
| `orphaned-doc` | **info** | **no** |

`pillar-unknown` was omitted from every prior enumeration. Note also that the gate is applied at *two
different layers* — two checks are gated by their call site, two gate themselves internally — so "is it inside
the `if` block?" is not a reliable reading.

**`orphaned-doc` has three independent dimensions, and the third is stated nowhere in this repo today.**
(1) *Gate membership* — it is **not** gated. (2) *Severity* — `info`, not `warning`. (3) **Blast radius** — it
therefore **can fire in a consumer's audit**, unlike every genuinely gated check. Dimension 3 is the one that
matters for the tool's design, and it is why the misclassification is a correctness issue rather than a
documentation nit: a check that reaches consumers cannot be reasoned about using the safety argument that
covers checks that do not. *(A sibling task corrects the four documents carrying the false claim; this record
explains why it matters.)*

### Ratifying the contract, accurately

**Exit codes converged fully — ratify as-is.** Both audits compute `hasErrors` as
`findings.some((f) => f.severity === 'error')` and then `process.exit(hasErrors ? 1 : 0)`; both catch at top
level, log `audit failed:`, and exit `2`.

Two residues are recorded rather than swept: this repo's `--fix` path has its own exit semantics (three
additional exit sites), and `gvt-construct3` has no `--fix` at all — its file header states *"Read-only — no
--fix / migration mode."* And this repo's own audit file-header comment documents only *"0 … 1 otherwise"*,
omitting the `2` its code implements. That omission is filed as #461 and is deliberately **not** fixed here.

**The record shape converged only *partially*. #452 claimed unqualified convergence.** For `file`, `config`
and `tool` findings both emit `{ kind, component, target, ok, severity, detail, reason }` in the same order
with the same types and semantics — on *unsatisfied* findings; satisfied ones carry a subset. Three
divergences must be **decided**, not merely described:

**(1) `required` is ratified INTO the contract, mandatory on expectation findings.** This repo emits it,
including in the satisfied case; `gvt-construct3` does not. Its absence there is not evidence against the
field — c3 has no need for it *because* its tally reads severity instead. `required` is the only field
carrying **declared** optionality, and it is what makes a policy-side tally possible at all. This repo's shape
is the superset and becomes the contract; c3's is the subset and gains one field. Additive, non-breaking.

**(2) `target` is ratified as display text, explicitly NOT a machine key.** `gvt-construct3` builds it as the
declared path plus a conditional `" (project root: …)"` disambiguator; this repo's is the raw declared path.
They are not the same field in any matchable sense. A consumer needing a key uses `{ kind, component }` plus
its own policy field.

**(3) A second record class is ratified, because one shape does not cover the data.** This repo emits
eighteen kinds carrying only `{ kind, ok, severity, detail }` — no `component`, no `target` — recognised by a
`SELF_CONTAINED_KINDS` list of ten plus a `pointer-` prefix rule covering eight more; `gvt-construct3` emits
none. So the contract ratifies **two** shapes with a discriminator:

- **`expectation`** — the seven core fields plus `required`. *The shared tool emits only these.*
- **`diagnostic`** — `{ kind, ok, severity, detail }`. *Plugins emit these from their own policy scanners and
  merge them into the finding list.*

This seam is what makes the non-delegable gate implementable rather than hand-waved: the gated checks are all
`diagnostic`-class and all plugin-owned, so "the tool never owns a severity-by-caller check" is enforced by
the shape rather than by discipline.

Also ratified: **`detail` is permitted on satisfied findings** — `gvt-construct3`'s satisfied `mcp` finding
sets it to the resolved version — so consumers must not read `detail`-presence as a failure signal. That `mcp`
kind is itself worth noting: it is a fourth expectation kind that one plugin has and the other lacks, so the
kind set is **open**, and the contract fixes the *shape* of an expectation finding, never the enumeration of
kinds.

### Hygiene is out of scope

Three independent grounds, each sufficient:

**1. There is no second consumer, and that is the finding.** `gvt-construct3` has zero hygiene scanning.
#452's AC4 asks how a shared hygiene layer would be validated against one consumer; the honest answer is that
it cannot be. Generalising against N=1 produces an interface shaped like its only caller — which
`RESERVED_PATH_KEYS` already demonstrates in this very codebase.

**2. The scanners are neutral; the policy welded to them is not.** `md-scan` self-describes as *"Pure and
fs-free"*, and `fs-walk` and `git-info` are generic. But every *finding* they produce depends on
`DEFAULT_RETIRED_TOKENS`, `DEFAULT_EXCLUDE_PATHS`, the docs-root derivation, and the per-scanner wiki/raw
scope table that ADR-0041 fixed and `plugin/CONVENTIONS.md` **publishes as contract**. The policy is not
adjacent to the scanners; it is what makes them mean anything.

**3. It straddles the gate boundary.** Two of the five content scanners run at `error` behind the author-time
gate and cannot move under the non-delegable rule. Splitting three out while two stay is a worse shape than
keeping all five together.

**Re-entry condition**, so this is a decision and not a shrug: **hygiene becomes eligible when a second plugin
independently needs the same scan.** The unit to share at that point is the fence-aware line iterator plus the
tracked-file walker — the two parts with no policy attached — never the scanners themselves.

### The duplicated lines stay duplicated, deliberately

`lib/config-resolve.mjs` and `lib/frontmatter.mjs` are **byte-identical** across the two repos — verified by
identical git blob SHAs at each repo's `origin/main`, not merely in the installed plugin caches:

```
$ git rev-parse origin/main:plugin/skills/audit-conventions/scripts/lib/frontmatter.mjs
fa0199916d1370fae2d4b4bd66cac822cea8a811   # both repos
$ git rev-parse origin/main:.../lib/config-resolve.mjs
4ac294cc1a157397aef3e478b15032f485bb3ec0   # both repos
```

**Decision: keep them duplicated for now.** Today's cost is not drift — the copies are identical *right now*.
It is **unverified** drift. This repo carries dedicated tests for both modules; `gvt-construct3` carries
**none**, so a change to its copy breaks nothing in its suite. The duplication is asymmetric in **coverage**,
not in code.

The cheap mechanism that buys the property a shared tool is meant to deliver — *a divergence fails that repo's
own build* — is mirroring those two test files into `gvt-construct3`: no production change, no npm, no npx, no
network, no lockstep release. Filed as **#460**. Absorption into the shared tool is #457's answer, and is
recorded here as conditional on it.

### Measured figures

Point-in-time, measured this run against this repo's working tree and `gvt-construct3` at its `origin/main`
(commit `3d12eb6`). Commands are given so a future reader can re-derive rather than trust:

```
# audit source (non-test .mjs) and test lines
find plugin/skills/audit-conventions/scripts -name '*.mjs' -not -path '*/test/*' | wc -l   ->  22 files
find ... -not -path '*/test/*' -exec cat {} + | wc -l                                      ->  4833 lines
find plugin/skills/audit-conventions/scripts/test -name '*.mjs' -exec cat {} + | wc -l     ->  7568 lines

# gvt-construct3, read from origin/main (its audit is 3 .mjs)
git show origin/main:.../audit.mjs | wc -l                                                 ->  693
git show origin/main:.../lib/config-resolve.mjs | wc -l                                    ->   26
git show origin/main:.../lib/frontmatter.mjs | wc -l                                       ->  138   (857 total)
git show origin/main:.../test/audit.test.mjs | wc -l                                       -> 1280
```

**Shared mechanism**, defined as the two duplicated modules whole (164 lines) plus the whole-function spans of
the eight functions named above:

| | mechanism | audit source | share |
|---|---|---|---|
| this repo | 308 | 4833 | 6.4% |
| `gvt-construct3` | 310 | 857 | 36.2% |

This is an **upper bound**: the spans are whole functions, and the resolution lines inside the three
evaluators are policy that would come out. #452's larger figure counted part of `formatReport`, most of which
is per-plugin report text rather than severity bucketing, and is superseded by the table above.

The 164 duplicated lines are **19.1%** of `gvt-construct3`'s audit source and **3.4%** of this repo's — the
asymmetry that makes a shared tool look very different from each side, and the reason the two rewiring issues
(#458, #459) are not the same size of job.

## Compromise

**A selectable tally was rejected**, and it was #452's own fallback, so rejecting it is a real cost: it would
have let both plugins keep their existing summary lines with one shared call. It is refused because a selector
puts a policy enum inside the tool, and the third audit turns that enum into a registry of callers. Emitting
no tally pushes a small, genuinely per-plugin computation back to each plugin — roughly a dozen lines each —
in exchange for a tool that cannot learn its callers' names.

**An `--author-time` flag was rejected** even though it is the obvious way to let the tool own the gated
checks. A flag is assertable by anyone; the current gate is *derived* and therefore cannot be asserted from
outside. Keeping the gate plugin-side means the shared tool is strictly less capable than either existing
audit — it can never run the five author-time checks — and that reduction is the point rather than a
shortfall.

**Ratifying `required` into the contract imposes a field on `gvt-construct3` that it does not use.** The
alternative — leaving `required` optional and letting each plugin discover its absence — was rejected because
it makes the policy-side tally decision unimplementable for this repo, and an optional field that one
consumer's tally hard-depends on is a contract in name only.

**Two record classes is more surface than one.** A single shape with `component` and `target` nullable was
considered and rejected: it would make "the tool emits only expectation findings" unstatable, and that
statement is what keeps the non-delegable gate enforced structurally instead of by convention.

**Hygiene is where the largest shareable-looking body of code is, and it is being left on the table.** The
scanners are genuinely well-factored and genuinely plugin-blind at the primitive layer. The refusal rests
entirely on there being no second consumer *yet*, which is why the re-entry condition above is stated
concretely rather than as "revisit later."

**Keeping 164 duplicated lines is the option that looks worst on a slide** and is chosen anyway, because the
property worth buying is not de-duplication — it is that a divergence *fails a build*. Mirroring tests buys
that property for a fraction of the cost and none of the coupling; extracting the modules buys it and also
buys a release-ordering dependency between two independently-versioned plugins.

### Relationship to prior records

**ADR-0047 is DISTINGUISHED, not overturned, and its standing directive is NOT triggered by this record.**
Stating this by name matters, because the natural reading of #452's title *would* trigger it, and a future
reader needs to see that the boundary decision above is what stopped it.

ADR-0047's Compromise rejected *adding an npm dependency to this repo* — it names "no `package.json` and no
npm at all" and the cost of "imposing it on every consumer's install path." This record adds none of that: no
`package.json`, no bare specifier, no network access, no change to any component's `metadata.expects.tools`.
ADR-0047's Consequences bind "any future widening of the citing corpus — or any change that makes the check
runnable outside `AUDITING_PLUGIN_SOURCE`"; under the non-delegable-gate rule above, nothing becomes so
runnable, because the gated checks never leave the plugin.

**Forward-binding clause: if packaging proceeds under #457, ADR-0047's directive is *pre-triggered*.** The
severity question for `pointer-anchor` and `principle-citation` reopens **before** any code moves, not after.
That is #456's subject.

One measured input to #456, recorded because it is cache-state-dependent and therefore easy to mis-remember
as settled. Re-measured this run:

```
$ npm_config_offline=true npx -y @genvidtech/construct3-chef --version
1.2.0        # exit 0 — the tarball IS cached on this machine today

$ npm_config_offline=true npx -y @genvidtech/<uncached-package> --version
npm error code ENOTCACHED ... cache mode is 'only-if-cached'
             # exit 1
```

So the hazard is real but **intermittent**: `npx` fails hard offline on a cache *miss*, and whether a given
package is cached is a property of the individual machine at that moment. An earlier probe of this same
pinned package failed with `ENOTCACHED`; it now succeeds. #456 must therefore treat offline `npx` as
*unreliable*, not as *reliably broken* — a failure that reproduces only on some machines is worse to depend on
than one that reproduces everywhere.

**ADR-0019 is EXTENDED, not contradicted.** Its safety argument — that `error` is acceptable for
`principle-citation` because the scanner is confined to `plugin/`, which a consumer lacks — is correct and
untouched. What is corrected is its *background enumeration*, which wrongly placed `orphaned-doc` in the gated
`warning` family. Its standing directive, that a further scanner decides severity on the merits, is
reaffirmed and gains a third data point: **a check can be author-time in intent and still ungated in fact.**

## Consequences

**Something is shippable immediately, with nothing moved.** The contract section is ratifiable today because
it describes agreement that already exists between two independent implementations. #457 can proceed against
a written target instead of discovering one.

**The shared tool will be smaller than it looks like it should be**, and reviewers should expect that. Roughly
6% of this repo's audit and 36% of `gvt-construct3`'s is in scope, the tool emits no tally and no report, and
it cannot run five of this repo's checks at all. A proposal that comes back materially larger has almost
certainly absorbed policy.

**`RESERVED_PATH_KEYS` is now a named defect with a home.** It is the concrete instance of the failure this
record exists to prevent, and #457 should not carry it across. Anything resembling a caller name inside the
shared tool is a boundary violation by definition, not a judgement call.

**The two-class finding shape is the load-bearing invariant to protect.** If a future change lets the shared
tool emit a `diagnostic`-class finding, the structural guarantee behind the non-delegable gate is gone and the
severity argument reverts to discipline. Watch for that specifically in review of #457.

**The duplication decision has an expiry, not a rule.** #460 makes divergence detectable; it does not make it
impossible. If the two copies ever diverge *intentionally*, this record's premise — that they are the same
code — fails, and the mechanism category must be re-derived rather than inherited.

**This record ships no behavior change**, so it carries no version bump. It documents a decision about future
work in two repositories, and its figures are point-in-time: a reader should re-run the commands above rather
than cite the numbers, particularly the `npx` probe, whose result depends on local cache state.
