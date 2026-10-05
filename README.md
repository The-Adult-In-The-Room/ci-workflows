# ci-workflows

Reusable GitHub workflows and composite actions shared across personal projects.

All e2e jobs use [Lightpanda](https://github.com/lightpanda-io/browser) for fast, consistent headless testing across every repo.

## Composite actions

| Action | Path | Purpose |
| --- | --- | --- |
| `setup-node` | `.github/actions/setup-node` | Install Node.js from `.nvmrc` and run `npm ci`. |
| `playwright-test` | `.github/actions/playwright-test` | Install Lightpanda and run a Playwright e2e npm script. |

On failure `playwright-test` uploads a `playwright-report` artifact named `playwright-report-<script>`, with every character `upload-artifact` rejects (`" : < > | * ? \r \n \ /`) rewritten to `-`. So `test:e2e:regression` uploads as `playwright-report-test-e2e-regression` — the colon has to go, because artifacts are downloaded onto NTFS volumes where it is a path separator.

## Reusable workflows

| Workflow | Path | Purpose |
| --- | --- | --- |
| `verify` | `.github/workflows/verify.yml` | PR gate: typecheck/lint/tests + acceptance e2e + optional Lighthouse CI. |
| `smoke` | `.github/workflows/smoke.yml` | Post-merge smoke e2e tests. |
| `regression` | `.github/workflows/regression.yml` | Scheduled regression tests against a production URL. |
| `dependabot-auto-merge` | `.github/workflows/dependabot-auto-merge.yml` | Auto-merge Dependabot PRs after `CI / verify` passes. |
| `lighthouse` | `.github/workflows/lighthouse.yml` | Run Lighthouse CI against a build. |

## Standard check names

Call each reusable workflow from a job named `CI` so every project reports the same check names:

- `CI / lint-and-test`
- `CI / acceptance`
- `CI / verify` — aggregate gate that only passes when `lint-and-test` **and** `acceptance` pass; `lighthouse` is ignored when skipped
- `CI / smoke`
- `CI / regression`
- `CI / lighthouse`

Use `CI / verify` in branch protection and in the Dependabot auto-merger so the entire PR verification workflow must pass before merging.

## Self-check

This repository gates its own changes with `Self Check`, which runs two independently-required jobs:

| Check | What it enforces |
| --- | --- |
| `lint` | `actionlint` — the workflows and actions are structurally valid YAML. |
| `contract` | `scripts/contract-check.mjs` — the *interface* to consumers holds up. |

`actionlint` cannot see the bugs that actually cost us consumers, because each one was valid YAML with a broken contract: a composite action referencing a sibling by relative path, `npm run ${{ inputs.command }}` where the default was a whole command, a required secret with no description, an artifact name interpolated from an input where the `:` in `test:e2e:regression` is an invalid artifact-name character. `contract` covers those six rules.

The check names `lint` and `contract` are stable and will not be reworded. Once a ruleset requires a check by name, renaming a job breaks every open PR and every branch-protection entry. Treat any change here as a breaking change.

Run either locally with `npm test` and `npm run contract`; `contract` also accepts explicit paths, e.g. `node scripts/contract-check.mjs .github/workflows/verify.yml`.

The rules are unit-tested against deliberately broken fixtures in `scripts/fixtures/`, one per historical bug. `npm test` also asserts that the real workflows satisfy every rule, so a rule that becomes too aggressive fails here rather than in someone's PR.

## Usage

```yaml
name: Verify
on:
  pull_request:
    branches: [main]

jobs:
  verify:
    name: CI
    uses: The-Adult-In-The-Room/ci-workflows/.github/workflows/verify.yml@v2.0.0
    with:
      run-lighthouse: true
    secrets:
      lhci-github-app-token: ${{ secrets.LHCI_GITHUB_APP_TOKEN }}
```

Omit `with.run-lighthouse` (or set it to `false`) to skip Lighthouse CI.

Replace `The-Adult-In-The-Room/ci-workflows` with the actual owner/repo if you fork or rename this repository.

## Versioning

Consumers pin to an **immutable semver tag**, never a branch. Tags are not moved once published.

| Change | Action |
| --- | --- |
| Backwards-compatible fix or new optional input with a default | Cut a new patch/minor tag, e.g. `v1.0.2` |
| Breaking change (renamed/removed input, changed default, renamed check) | Cut `v2.0.0`; consumers opt in via a reviewed PR |
| Internal-only change (comments, docs) | Push to `main`, cut a tag when convenient |

Because tags are immutable, pushing to `main` does **not** change what consumers resolve. Propagation only happens when a new tag exists and a consumer bumps to it. Each consumer's Dependabot config watches the `github-actions` ecosystem and groups these references separately from third-party actions, so version bumps arrive as reviewable PRs.

Internal cross-references inside this repository (the workflows and the `playwright-test` composite action calling `setup-node`) are pinned to the same release tag. If you cut a new tag, update those internal refs in the same commit — otherwise a consumer pinned to `v1.0.1` would silently pick up an unpinned change.

Do not create a branch named `v1`. Git resolves `refs/tags/v1` before `refs/heads/v1`, so the tag wins, but the branch will cause confusion later.

