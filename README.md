# ci-workflows

Reusable GitHub workflows and composite actions shared across personal projects.

All e2e jobs use [Lightpanda](https://github.com/lightpanda-io/browser) for fast, consistent headless testing across every repo.

## Composite actions

| Action | Path | Purpose |
| --- | --- | --- |
| `setup-node` | `.github/actions/setup-node` | Install Node.js from `.nvmrc` and run `npm ci`. |
| `playwright-test` | `.github/actions/playwright-test` | Install Lightpanda and run a Playwright e2e npm script. |

## Reusable workflows

| Workflow | Path | Purpose |
| --- | --- | --- |
| `verify` | `.github/workflows/verify.yml` | PR gate: typecheck/lint/tests + acceptance e2e. |
| `smoke` | `.github/workflows/smoke.yml` | Post-merge smoke e2e tests. |
| `regression` | `.github/workflows/regression.yml` | Scheduled regression tests against a production URL. |
| `dependabot-auto-merge` | `.github/workflows/dependabot-auto-merge.yml` | Auto-merge Dependabot PRs after `CI / verify` passes. |
| `lighthouse` | `.github/workflows/lighthouse.yml` | Run Lighthouse CI against a build. |

## Standard check names

Call each reusable workflow from a job named `CI` so every project reports the same check names:

- `CI / lint-and-test`
- `CI / acceptance`
- `CI / verify` — aggregate gate that only passes when `lint-and-test` **and** `acceptance` pass
- `CI / smoke`
- `CI / regression`
- `CI / lighthouse`

Use `CI / verify` in branch protection and in the Dependabot auto-merger so the entire PR verification workflow must pass before merging.

## Usage

```yaml
name: Verify
on:
  pull_request:
    branches: [main]

jobs:
  verify:
    name: CI
    uses: The-Adult-In-The-Room/ci-workflows/.github/workflows/verify.yml@v1.0.0
```

Replace `The-Adult-In-The-Room/ci-workflows` with the actual owner/repo if you fork or rename this repository.

## Versioning

Consumers pin to an **immutable semver tag**, never a branch. Tags are not moved once published.

| Change | Action |
| --- | --- |
| Backwards-compatible fix or new optional input with a default | Cut a new patch/minor tag, e.g. `v1.0.1` |
| Breaking change (renamed/removed input, changed default, renamed check) | Cut `v2.0.0`; consumers opt in via a reviewed PR |
| Internal-only change (comments, docs) | Push to `main`, cut a tag when convenient |

Because tags are immutable, pushing to `main` does **not** change what consumers resolve. Propagation only happens when a new tag exists and a consumer bumps to it. Each consumer's Dependabot config watches the `github-actions` ecosystem and groups these references separately from third-party actions, so version bumps arrive as reviewable PRs.

Internal cross-references inside this repository (the workflows and the `playwright-test` composite action calling `setup-node`) are pinned to the same release tag. If you cut a new tag, update those internal refs in the same commit — otherwise a consumer pinned to `v1.0.1` would silently pick up an unpinned change.

Do not create a branch named `v1`. Git resolves `refs/tags/v1` before `refs/heads/v1`, so the tag wins, but the branch will cause confusion later.

