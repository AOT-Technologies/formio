# Dependabot runbook

How dependency updates arrive in this repo, what each badge means, and the
one-pass routine for the grouped patch PR.

## Review tiers

| Badge in title | Label | What it is | Routine |
|---|---|---|---|
| `[✅ PATCH-ONLY]` | `deps: patch ✅ one-pass review` | **One** grouped PR with every patch-level bump across `/` and `/portal` (`Bump the patch-only-safe group across 2 directories with M updates`). | CI green → lockfiles-only diff → merge. One pass. |
| `[🟡 MINOR]` | `deps: minor 🟡` | Individual PR, minor bump, one dependency in one directory. | Read release notes, CI green, smoke-test if UI-facing. |
| `[🔴 MAJOR]` | `deps: major 🔴 breaking-risk` | Individual PR, major bump. | Migration guide, check whether upstream `formio/formio` already ships it, manual regression. Or `@dependabot ignore this major version`. |
| `[🔒 SECURITY]` | `deps: security 🔒` | **One** grouped PR for Dependabot security updates (`security-fixes` group). | Priority over everything else. CI green → merge. |

Every Dependabot PR also gets a sticky comment with a shields badge, the
metadata (highest bump, group, directories, dependencies) and the checklist for
its tier. The comment is refreshed on every rebase; the PR body is left alone
because PR-Agent rewrites it.

## Where things live

| File | Purpose |
|---|---|
| `.github/dependabot.yml` | Schedule, grouping, cooldown, policy-frozen ignores. |
| `.github/workflows/dependabot-triage.yml` | Labels, title badges, sticky comment, opt-in auto-merge. |
| `.github/workflows/formsflow-forms-ci.yml` | The CI that validates Dependabot PRs (Lint, Unit Test, Build). Covers `/` and `Dockerfile`; `/portal` and `docker-compose.yml` have no CI. |

There is no `CODEOWNERS`; branch protection on `develop` asks for one approving
review. (The old `reviewers:` key in `dependabot.yml` was removed by GitHub in
May 2025.)

## First-time setup (once, by a repo admin)

1. Merge the three files to `develop` (the default branch; Dependabot reads the
   config from there).
2. Actions → **Dependabot Triage** → **Run workflow**. This creates the four
   tier labels. Dependabot never creates custom labels itself.
3. Settings → Code security → confirm **Dependabot alerts** and
   **Dependabot security updates** are enabled (both were on as of 2026-11-03).
   Leave **Grouped security updates** as is: the `security-fixes` group in the
   config overrides it.
4. Optional, for hands-off patch merging:
   - Settings → General → enable **Allow auto-merge** (off today).
   - Branch protection on `develop` with `Lint`, `Unit Test` and `Build` as
     required checks (today: one review required, no required checks).
   - Settings → Secrets and variables → Actions → **Variables** → add
     `DEPENDABOT_AUTOMERGE_PATCH` = `true`.
   Until that variable exists, nothing merges on its own. While the one-review
   rule stays, auto-merge still waits for that approval.

## Weekly cadence

Thursday 09:00 IST npm, 09:30 docker, 10:00 docker-compose, 10:30 GitHub
Actions. Dependabot opens the npm patch group plus up to nine individual
minor/major PRs per run (limit 10 open).

To refresh on demand: **Insights → Dependency graph → Dependabot → Check for
updates** (per ecosystem). Config errors show on the same page.

## Cooldown (supply-chain guard)

An npm release is not proposed until it has been public for:

| Bump | Days |
|---|---|
| patch | 7 |
| minor | 14 |
| major | 30 |

Security updates ignore cooldown. Docker, docker-compose and GitHub Actions
have no cooldown (same as the other formsflow repos). Lower the numbers in
`dependabot.yml` if a needed fix is being held back.

## Policy-frozen dependencies (proposal)

This repo has no `CLAUDE.md` or policy doc, so the `ignore:` block is the
standard formsflow freeze list trimmed to what this repo declares, plus the
fork-tracked engine (FWF-6827). Nothing in docker, docker-compose or GitHub
Actions is ignored.

- Portal UI: `react`, `react-dom`, `@types/react`, `@types/react-dom` (no minor, no major)
- Tooling: `webpack`, `webpack-cli`, `typescript`, `eslint`, `eslint-config-*`, `eslint-plugin-*`, `prettier` (no major)
- Fork-tracked, follow upstream `formio/formio`: `@formio/*`, `formiojs`, `formio-workers`, `resourcejs`, `express`, `mongoose`, `mongodb` (no major)

To plan one of these upgrades, delete its `ignore` entry in a feature branch
and run **Check for updates**; the PR arrives as `[🔴 MAJOR]`.

## Useful PR commands

Comment on the PR:

```text
@dependabot rebase
@dependabot recreate
@dependabot ignore this minor version
@dependabot ignore this major version
@dependabot ignore this dependency
@dependabot close
```

`recreate` is the fix when a group PR has drifted after other merges.

## Gotchas

- **Target branch.** Do not add `target-branch:` to any block. Security
  updates only ever target the default branch, and a non-default
  `target-branch` detaches them from the groups and labels (this is why the
  sibling `forms-flow-ai` repo still receives one-off security PRs).
- **Labels.** Unknown labels in `dependabot.yml` are silently ignored. Keep
  custom labels in the triage workflow, which creates them.
- **Secrets.** Dependabot-triggered workflow runs cannot read Actions secrets.
  The triage workflow uses only `GITHUB_TOKEN`; keep it that way.
- **Grouped PR title.** The title is generated by Dependabot and can be
  regenerated on `recreate`; the triage workflow re-applies the badge on every
  `synchronize` event.
- **`group-by: dependency-name`.** Would collapse "same dependency, two
  directories" minor bumps into one PR, but combining it with `update-types` is
  not documented. Left as a commented option in `dependabot.yml`; trial it on
  a branch before adopting.
- **`/portal` has no CI.** A PR that touches only `portal/` is green because
  nothing runs. Run `npm run build:portal` locally before merging a minor or
  major there. Its `@formio/*` dependencies are git URLs; Dependabot skips them.
- **Legacy Dockerfile.** `openshift_custom_Dockerfile` pins `node:12.2.0-alpine`
  and will raise one `[🔴 MAJOR]` PR. Reply `@dependabot ignore this dependency`
  on that PR, or delete the file.
- **Mongo.** `docker-compose.yml` pins `mongo:5.0` and CI runs `mongo:5`. A
  Mongo major PR is a platform decision for forms-flow-ai, not a routine merge.
