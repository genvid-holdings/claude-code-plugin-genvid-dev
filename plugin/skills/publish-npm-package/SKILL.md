---
name: publish-npm-package
description: >-
  Set up a TypeScript package to publish publicly on npmjs.com via the shared
  GenvidTechnologies/public-github-actions GitHub Actions recipe with OIDC
  trusted publishing (automatic provenance, no stored npm token). This is the
  rare, once-per-package setup
  nobody remembers the steps for, so reach for it WHENEVER someone wants a
  package onto npm or made publicly installable — even when they don't say
  "npm", "publish", or name the recipe. Trigger on requests like "open-sourcing
  this library", "make this package public", "get it onto npm so others can npm
  install it", "set up a release pipeline for this lib", "publish the first
  version to npmjs", "have releases show up on npm automatically", "wire up
  trusted publishing / provenance", "stop keeping an npm token in repo secrets",
  scoping a package under @genvidtech, or moving a repo from pnpm to npm or CircleCI
  to GitHub Actions for releasing. It owns the whole job — package.json
  publish-readiness, the ci.yml/publish.yml workflows, the lockfile migration,
  and the one-time npm bootstrap handoff — so prefer it over wiring these steps
  together ad hoc or a generic planning skill. Genvid-first, but the
  npm-readiness and OIDC steps apply to any package. Do NOT use it for a routine
  version bump or release tag of a package that already publishes, publishing to
  a private/internal registry (e.g. Azure Artifacts, GitHub Packages), adding or
  installing a dependency, or non-npm publishing such as Docker images, the
  Construct3 marketplace, or GitHub Pages.
metadata:
  expects:
    tools:
      - command: gh
        reason: Fetches the live public-github-actions recipe and checks repo visibility for provenance
      - command: npm
        reason: Generates package-lock.json and runs the publish dry-run / pack manifest checks
      - command: git
        reason: Stages the migration as small reviewable commits
    files:
      - path: package.json
        required: false
        reason: The package manifest being prepared for npm publishing — only this skill needs it, so it's not a universal contract requirement
---

# Publish a package to npm (public-github-actions recipe)

This skill converts a buildable TypeScript package into one that publishes to
npmjs.com automatically on a version tag, using **OIDC trusted publishing** (no
long-lived npm token) and the shared **`GenvidTechnologies/public-github-actions`**
GitHub Actions workflows.

It executes the migration directly, with verification gates, and then hands off
the parts only a human with npm-account access can do (the one-time bootstrap
and the release tag).

Work in small, reviewable commits — one logical change per commit — so the diff
reads as a sequence (`metadata → lockfile → CI → docs → fix`). The same
preparation-before-feature discipline applies: get the package *publishable*
before wiring the automation that publishes it.

## When this applies / when it doesn't

Use it when a package needs to start publishing to npm, or when migrating an
existing package's release pipeline to the public-github-actions recipe. Signals:
"publish to npmjs.com", "pnpm → npm", "CircleCI → GitHub Actions", "trusted
publishing", "@genvidtech scope", "provenance".

It is **not** for: publishing to a private/internal registry, packages that have
**nothing to validate or publish**, or first-time repo creation. A package with
no compilation step — a Cordova plugin, a vanilla-JS library — *is* in scope; the
recipe works once its four gate scripts are satisfied (see
[**No-build packages**](#no-build-packages) below). The repo must be a git repo
whose gate scripts run; if not, fix that first.

## No-build packages

A package with no compilation step (a Cordova plugin, a vanilla-JS library that
ships its sources as-is with a hand-maintained `types/index.d.ts`) still works
with this recipe — the only wrinkle is the gate. The node-gate runs
`lint → typecheck → test → build` **unconditionally**, so all four scripts must
exist even when nothing compiles. Satisfy them **honestly**, not by cargo-culting
a build:

- **`typecheck` — make it real.** Point `tsc --noEmit` at the hand-maintained
  declarations so the published types actually get checked:
  ```json
  // package.json
  "scripts": { "typecheck": "tsc --noEmit" }
  ```
  ```json
  // tsconfig.json — minimal, just enough to type-check the .d.ts
  { "files": ["types/index.d.ts"] }
  ```
- **`test` / `build` — honest no-ops.** When there genuinely is nothing to run or
  compile, say so in the script itself rather than faking work:
  ```json
  "scripts": {
    "test": "echo \"no host-side tests\"",
    "build": "echo \"ships sources as-is — no build step\""
  }
  ```
  A documented no-op is self-explaining in CI logs; an empty or absent script
  fails the gate.
- **Skip the build-only guidance.** The `prepack`/`dist` entry-point setup
  (Phase 3) and the `publishConfig`-override gotcha (Phase 4) **do not apply** —
  there is no build output to ship or mis-resolve. Top-level `main`/`types` point
  at the real source/declaration files, which are already in the tarball.
- **Verify the tarball ships only what you mean.** Run `npm pack --dry-run` (or
  `npm publish --dry-run`) and read the file list — a no-build package has no
  `dist/` to gate on, so the risk shifts to *over*-shipping. Tighten `.npmignore`
  (or `files`) to exclude dev/planning artifacts (tests, configs, `plan.md`,
  scratch dirs) that a source-shipping package would otherwise include.

Everything else in this skill (OIDC publishing, the `publish.yml` filename match,
the Phase 5 bootstrap) is identical.

## The recipe is the source of truth — fetch it live

`public-github-actions` owns the canonical workflows and the onboarding runbook.
**Do not embed or guess its contents** — fetch the current versions so you never
act on a stale copy:

```bash
# Runbook + templates (decode base64 from the contents API):
gh api repos/GenvidTechnologies/public-github-actions/contents/README.md --jq .content | base64 -d
gh api repos/GenvidTechnologies/public-github-actions/contents/templates/ci.yml --jq .content | base64 -d
gh api repos/GenvidTechnologies/public-github-actions/contents/templates/publish.yml --jq .content | base64 -d
```

Read the README's "Onboarding" and "Cutting a release" sections — they are
authoritative. If the file layout has changed, list the tree first:
`gh api repos/GenvidTechnologies/public-github-actions/git/trees/HEAD?recursive=1 --jq '.tree[].path'`.

The templates are designed to be **drop-in with zero per-package edits**. Copy
them verbatim. In particular, `publish.yml` **must keep that exact filename** —
the npm trusted-publisher registration matches against it.

> **Non-genvid package?** There's no public-github-actions to fetch. Reuse the same
> shape: a `ci.yml` that runs lint/typecheck/test/build on PRs and pushes, and a
> `publish.yml` triggered on `v*.*.*` tags with `permissions: id-token: write`
> that runs `npm publish --provenance --access public`. The Phase 2–4 readiness
> and verification steps below are identical.

## Phase 1 — Assess current state (gather, don't assume)

Establish these facts before touching anything; each one drives a later
decision. Report a short summary to the user.

- **`package.json`**: current `name`, `version`, `main`/`types`/`exports`,
  `files`, `scripts` (is there `build`/`lint`/`typecheck`/`test`?),
  `publishConfig`, `repository`, `engines`. Are scripts runner-agnostic or do
  they hardcode `pnpm`?
- **Node-version drift**: does the README state a Node requirement (e.g.
  "Node.js 18+", "requires Node N")? Compare it to `package.json`'s
  `engines.node`. If they disagree, flag it — the README gets reconciled in the
  Docs step (Phase 3). Shipping a published README that understates the runtime
  requirement is the same class of stale-doc bug as pnpm→npm command drift.
- **Lockfile**: is `package-lock.json` committed? (`npm ci` and the gate's
  `cache: npm` require it.) Is `pnpm-lock.yaml` tracked?
- **CI**: what exists today (`.circleci/`, other `.github/workflows/`)? What does
  it publish to (npm? a blob store?) — that's what you're replacing.
- **Repo visibility**: `gh repo view <org>/<repo> --json visibility`. npm
  **provenance requires a public repo** — flag loudly if private.
- **npm registry state**: `npm view <name> version` and the scoped form. Is the
  name taken? At what versions? Scoped vs unscoped? This decides the publishable
  version (you cannot republish an existing version).
- **Is `dist/` gitignored?** If yes, the published tarball needs a `prepack`
  build step (see Phase 3).
- **Self-imports**: does anything in `src`/`test` import the package by its own
  name? (Usually tests use relative paths — confirm, because it affects whether
  changing entry points is safe.)

## Phase 2 — Decisions to surface to the user

These genuinely change the outcome — present them, don't pick silently:

1. **Package name / scope.** Genvid convention is scoped `@genvidtech/<pkg>`. If the
   package is currently unscoped (or published unscoped), renaming to a scope is
   a **new package name** — its bootstrap and trusted-publisher setup do **not**
   carry over from the old name and must be done fresh. Make that cost explicit.
2. **Version.** It must not collide with a version already on the registry under
   the chosen name. A rename frees up versions that were taken under the old
   name. State what the first publishable version will be.
3. **Release scope.** Wire up CI only, or also cut the first release? The first
   release depends on the manual bootstrap (Phase 5), which only the user can do.

If a `public-github-actions` setup already exists for the chosen name and the user
says trusted publishing is configured, confirm *which exact name* it was
configured for — a scope change invalidates that assumption.

## Phase 3 — Execute the migration (one commit per step)

Make the package publishable first, then wire the automation.

1. **`package.json` publishing metadata.**
   - Set the chosen `name`.
   - Add `repository` in the `git+https://github.com/<org>/<repo>.git` form
     (npm provenance matches against it; this exact form avoids npm's
     auto-normalize warning).
   - Add a top-level `description` (the npm page) and optionally `homepage`,
     `bugs`, `keywords`.
   - For a **scoped** package, add `"publishConfig": { "access": "public" }` —
     scoped packages are private by default.
   - If `dist/` is gitignored, add `"prepack": "npm run build"` so local
     `npm pack`/`npm publish` always ship built output.
   - **Entry points → `dist/` directly** (see the gotcha in Phase 4): top-level
     `main`/`types`/`exports` resolve to the built files.

2. **pnpm → npm.** `git rm pnpm-lock.yaml`; run `npm install` to generate and
   commit `package-lock.json`. The `package.json` scripts are usually already
   runner-agnostic (`tsc`/`mocha`/`eslint`); only change them if they hardcode
   `pnpm`.

3. **Capability/config files.** If the repo has a `.gvt-agent.json` (or
   similar) with `pnpm run …` commands or the old name, update them to npm and
   the new name.

4. **GitHub Actions.** Add `.github/workflows/ci.yml` and
   `.github/workflows/publish.yml` verbatim from the fetched templates.

5. **Remove the old CI.** `git rm -r .circleci/` (or whatever is being
   replaced). Don't leave a dual pipeline.

6. **Docs.** Update `CLAUDE.md`/`README.md`: pnpm→npm commands, old-CI→GitHub
   Actions, the public-install instructions (`npm install <name>`), import
   examples using the final (possibly scoped) name, and drop any "private
   package" framing. Grep for stale references to the old package name and the
   old package manager. Also grep the README for any Node-version claim and
   reconcile it with `package.json`'s `engines.node` — update the README to
   match `engines` (or fix `engines` if the README is the source of truth).

## Phase 4 — Validate (and the gotcha that will bite you)

Run the full suite the gate will run: `npm run lint && npm run typecheck &&
npm run test && npm run build`.

Then **verify what actually gets published** — this is the step people skip and
regret:

```bash
npm publish --dry-run --access public      # lists tarball contents + warnings
npm pack                                    # then inspect the PACKED manifest:
tar -xzO -f *.tgz package/package.json | node -e "const d=JSON.parse(require('fs').readFileSync(0)); console.log(d.main, d.types, JSON.stringify(d.exports))"
rm -f *.tgz
```

Confirm: the tarball contains `dist/`, `LICENSE`, and `README.md`; and the
**packed `package.json` entry points resolve to `./dist/…`, not `./src/…`**.

> **🔴 The publishConfig-override gotcha.** Older guidance put `main`/`types`/
> `exports` *inside* `publishConfig` to swap `src`→`dist` only at publish time.
> **npm 11.x no longer applies those overrides** — it warns "Unknown
> publishConfig config" and ships the top-level (source-pointing) values. A
> package published this way resolves to `./src/index.ts`, which isn't even in
> the tarball, and breaks for every consumer. The fix is simple and robust:
> point top-level `main`/`types`/`exports` at `dist/` and keep only `access` in
> `publishConfig`. Always confirm via the packed manifest, not the dry-run
> notice alone — `npm pack` is the ground truth.

If a CI-driven release won't run a build before `npm publish`, the `prepack`
script (Phase 3) is what guarantees `dist/` exists in the tarball.

Also verify that each `uses:` reference in the newly-written ci.yml and
publish.yml resolves to its canonical path — run `gh api repos/<owner>/<repo>
--jq .full_name` and confirm the returned `full_name` matches the path written
in `uses:`. A template that itself shipped a stale ref (e.g. after a shared-CI
repo rename) would otherwise pass every API check and fail the Actions run at
0 seconds. See `release-npm-package`'s hard-gate check for the full detection
rationale.

## Phase 5 — Release runbook (hand off the human-only parts)

The remaining steps are outward-facing. Do the in-repo/git parts only with the
user's go-ahead, and clearly mark the npm-account step as theirs.

1. **Push branch, open PR, merge to the default branch** — the CI gate runs on
   the PR.
2. **🔴 One-time npm bootstrap (user only, blocking).** OIDC **cannot perform a
   package name's first publish**, so the name must be claimed once with a
   short-lived granular token, then the trusted publisher registered:
   - `npm version <v>-bootstrap.0 --no-git-tag-version` → `npm publish
     --access public` (using a shortest-expiry granular token, used locally
     only) → `npm deprecate "<name>@<v>-bootstrap.0" "bootstrap placeholder"` →
     restore the real version.
   - On npmjs.com → package → **Settings → Trusted Publisher**, add the GitHub
     publisher: org, repo, **workflow filename `publish.yml`**, environment
     blank.
   - **Revoke the token.** No long-lived credential remains.
   - (Defer to the live README — it is authoritative if these steps changed.)
3. **Tag and push.** `git tag v<X.Y.Z> && git push origin v<X.Y.Z>` →
   `publish.yml` re-runs the gate, enforces tag↔`package.json` version equality,
   and publishes with `--provenance`. If the publish run fails instantly (0
   seconds, "workflow file issue", no jobs started), suspect a stale `uses:`
   reference (a shared-CI repo was renamed or moved), not the package — see
   `release-npm-package`'s hard-gate redirect check.
4. **Verify the provenance badge** on the npmjs.com package page.

If the name was changed in Phase 2, note that any previously-published versions
under the old name are now orphaned (and may have been published with the broken
source-pointing manifest); they can be `npm deprecate`d later, pointing at the
new name.

## Why these choices

- **Trusted publishing over a stored token**: a short-lived OIDC credential
  minted per-run means no secret to leak, and provenance is automatic.
- **Drop-in shared workflows**: keeping `ci.yml`/`publish.yml` edit-free means
  every package upgrades by re-copying, and the trusted-publisher match against
  `publish.yml` stays stable.
- **Verify the packed manifest, not just the dry-run**: the dry-run lists files
  but the entry-point bug lives in the manifest npm rewrites — only `npm pack`
  shows you the truth a consumer will see.
