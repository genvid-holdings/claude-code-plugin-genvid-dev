# 0013. Scope the `audit-conventions --fix` CONVENTIONS.md resync to the migrated state only

- **Status:** accepted
- **Date:** 2026-07-20
- **Issue:** #132

## Context

`audit-conventions --fix` never refreshed an existing `CONVENTIONS.md`, even when that
file is a pure canonical copy that has drifted behind the plugin — it printed
"SKIPPED … keeping your copy" for any existing file. Consuming repos' contract copies
drifted silently and indefinitely after every plugin update; the only fix was a manual
`cp` from an unguessable plugin cache path. Two shipped docs (`plugin/CONVENTIONS.md:12`,
`plugin/skills/sync-config/SKILL.md`) already claimed the audit reports drift and
`--fix` resyncs — but neither behavior existed.

## Decision

Add the resync as a **migrated-state-only** behavior, not a change to the shared
`pushScaffold` skip-if-exists helper. Two surfaces:

1. A new `planMigratedResync` planner reached via a restructured `runFix` migrated
   branch — the old `STATE_MIGRATED` early-return is deleted so migrated repos inherit
   the existing clean-tree apply gate, dry-run preview, and reconciliation. The resync
   is **vetoable**: dry-run shows a `+N/−M` diff hint; `--fix --apply` refuses a dirty
   tree.
2. A new validate-mode `evaluateConventionsDrift` emitting a non-fatal **warning** on
   drift, which finally makes the docs' "reports drift" claim true.

Both use the cheap first-cut discriminator (differ-from-current-canonical) rather than
a shipped prior-canonical hash manifest. Architecture: the resync is scoped to the
`migrated` arm of `runFix`'s per-state branch, alongside the `stale-config` precedent
in 0012 — state-specific mutation logic stays local to its own branch rather than
touching the shared scaffold path used by every other state.

## Compromise

Alternatives rejected:

- **Drift-aware `pushScaffold` across all states + a dedicated `--resync-conventions`
  flag** — rejected: `pushScaffold`'s skip-if-exists for `CONVENTIONS.md` is load-bearing
  #25 hand-edit protection (a greenfield repo may carry a hand-written/forked copy that
  must never be clobbered; `migrate.test.mjs:266` ("pre-existing CONVENTIONS.md / CLAUDE.md are SKIPPED, not overwritten") guards exactly this). A blanket
  drift-overwrite would regress that. A dedicated flag is also redundant new surface
  that bypasses the existing dry-run/clean-tree/reconcile machinery and contradicts
  `sync-config`, which already routes users to `--fix`.
- **Prior-canonical hash manifest** shipped with the plugin (to precisely distinguish
  hand-edited from unmodified-stale) — rejected: the issue explicitly blesses the cheap
  first cut, and the vetoable dry-run already covers the hand-edited case without a
  maintained hash artifact needing an update on every release.

## Consequences

`CONVENTIONS.md` resync is well-defined only where the file is definitionally a
canonical copy (the migrated state); greenfield/stale/legacy paths are untouched,
preserving #25. The rare hand-edited-in-migrated case is protected by the mandatory
dry-run diff + clean-tree apply gate (the user's veto point) rather than by precise
edit-detection. The doc claims in `CONVENTIONS.md` and `sync-config` become accurate in
the same PR.
