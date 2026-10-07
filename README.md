# ci-workflows

Reusable GitHub workflows and composite actions shared across personal projects.

For detailed guides, see the **[wiki](https://github.com/The-Adult-In-The-Room/ci-workflows/wiki)**. The wiki source lives in the `wiki/` directory of this repo and is auto-published to GitHub on every push to `main`:

- [Consumer Guide](https://github.com/The-Adult-In-The-Room/ci-workflows/wiki/Consumer-Guide) — how to add these workflows to your repository
- [Release Process](https://github.com/The-Adult-In-The-Room/ci-workflows/wiki/Release-Process) — how to cut a new semver release
- [Troubleshooting](https://github.com/The-Adult-In-The-Room/ci-workflows/wiki/Troubleshooting) — common failures and how to fix them
- [Migration Notes](https://github.com/The-Adult-In-The-Room/ci-workflows/wiki/Migration-Notes) — template and history for breaking changes

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
| `deploy-and-smoke` | `.github/workflows/deploy-and-smoke.yml` | Deploy to Railway, run smoke e2e tests, and roll back on failure. |
| `smoke` | `.github/workflows/smoke.yml` | Smoke e2e tests against a provided base URL. |
| `regression` | `.github/workflows/regression.yml` | Scheduled regression tests against a production URL. |
| `dependabot-auto-merge` | `.github/workflows/dependabot-auto-merge.yml` | Auto-merge Dependabot PRs after `CI / verify` passes. |
| `lighthouse` | `.github/workflows/lighthouse.yml` | Run Lighthouse CI against a build. |

## Standard check names

Call each reusable workflow from a job named `CI` so every project reports the same check names:

- `CI / lint-and-test`
- `CI / acceptance`
- `CI / verify` — merge gate; only `lint-and-test` **and** `acceptance` are required to pass. `lighthouse` is advisory and ignored by the gate
- `CI / deploy`
- `CI / smoke`
- `CI / rollback`
- `CI / regression`
- `CI / lighthouse`

Use `CI / verify` in branch protection and in the Dependabot auto-merger so the entire PR verification workflow must pass before merging. See the [Consumer Guide](https://github.com/The-Adult-In-The-Room/ci-workflows/wiki/Consumer-Guide) for setup details.

## Dependabot and secret-requiring checks

Dependabot pull requests run with a **read-only** `GITHUB_TOKEN` and **no access to repository secrets**. Any check that needs a secret will fail on those PRs. For that reason:

- `CI / lighthouse` is **advisory**. It needs `LHCI_GITHUB_APP_TOKEN`, so it is skipped on Dependabot PRs because they cannot access repository secrets. Do **not** require `CI / lighthouse` in branch protection.
- The merge gate is `CI / verify`, which only requires `lint-and-test` and `acceptance` to pass.
- Any future secret-requiring job (for example, a canary deployment) must follow the same pattern: report its result, but never become a required check.

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

## Quick usage

```yaml
name: Verify
on:
  pull_request:
    branches: [main]

jobs:
  verify:
    name: CI
    uses: The-Adult-In-The-Room/ci-workflows/.github/workflows/verify.yml@v2.1.1
    with:
      run-lighthouse: true
    secrets:
      lhci-github-app-token: ${{ secrets.LHCI_GITHUB_APP_TOKEN }}
```

Omit `with.run-lighthouse` (or set it to `false`) to skip Lighthouse CI.

Replace `The-Adult-In-The-Room/ci-workflows` with the actual owner/repo if you fork or rename this repository.

For full setup instructions — including smoke tests, regression tests, Dependabot config, and branch protection — see the [Consumer Guide](https://github.com/The-Adult-In-The-Room/ci-workflows/wiki/Consumer-Guide).

## Versioning

Consumers pin to an **immutable semver tag**, never a branch. Tags are not moved once published.

See the [Release Process](https://github.com/The-Adult-In-The-Room/ci-workflows/wiki/Release-Process) wiki page for the full release checklist, including how to update internal cross-references.

