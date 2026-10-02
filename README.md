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
    uses: The-Adult-In-The-Room/ci-workflows/.github/workflows/verify.yml@main
```

Replace `The-Adult-In-The-Room/ci-workflows` with the actual owner/repo if you fork or rename this repository.
