This page explains how to add `The-Adult-In-The-Room/ci-workflows` to your repository.

## Prerequisites

Your repo must expose these npm scripts and files:

- `.nvmrc` — Node version used by `setup-node`
- `npm run verify` — typecheck, lint, format, unit tests
- `npm run build` — production build
- `npm run test:e2e:acceptance` — acceptance e2e suite
- `npm run test:e2e:smoke` — smoke e2e suite (run by `deploy-and-smoke.yml` against the deployed URL)
- `npm run test:e2e:regression` — scheduled regression suite against production

## Add the PR gate (`verify.yml`)

Create `.github/workflows/ci.yml` in your consumer repo:

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  verify:
    name: CI
    uses: The-Adult-In-The-Room/ci-workflows/.github/workflows/verify.yml@v2.1.1
    secrets: inherit
    with:
      run-lighthouse: true
```

> Replace `v2.1.1` with the latest immutable semver tag. Never pin to a branch.

## Add deploy-and-smoke tests

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    name: CI
    uses: The-Adult-In-The-Room/ci-workflows/.github/workflows/deploy-and-smoke.yml@v2.1.1
    with:
      project: ${{ vars.RAILWAY_PROJECT }}
      service: ${{ vars.RAILWAY_SERVICE }}
      environment: production
    secrets:
      railway-token: ${{ secrets.RAILWAY_TOKEN }}
```

This workflow:

1. Deploys the current commit to Railway.
2. Waits for the deployment to reach `SUCCESS`.
3. Discovers the deployment URL (or uses the explicit `url` input).
4. Runs `npm run test:e2e:smoke` against that URL.
5. If smoke tests fail, redeploys the previous successful commit.

Set `RAILWAY_PROJECT` and `RAILWAY_SERVICE` as repository variables, and `RAILWAY_TOKEN` as a repository secret.

## Run smoke tests against an arbitrary URL

If you already have a deployed URL and just want to run the smoke suite, use `smoke.yml` directly:

```yaml
name: Smoke

on:
  workflow_dispatch:

jobs:
  smoke:
    name: CI
    uses: The-Adult-In-The-Room/ci-workflows/.github/workflows/smoke.yml@v2.1.1
    with:
      base-url: "https://your-url.example.com"
```

When `base-url` is empty, the smoke script uses its own default target.

## Add scheduled regression tests

```yaml
name: Regression

on:
  schedule:
    - cron: "0 6 * * 1" # Mondays at 06:00 UTC
  workflow_dispatch:

jobs:
  regression:
    name: CI
    uses: The-Adult-In-The-Room/ci-workflows/.github/workflows/regression.yml@v2.1.1
    with:
      base-url: ${{ vars.REGRESSION_BASE_URL }}
      base-url-required: true
```

Set `REGRESSION_BASE_URL` as a repository variable, or omit `base-url-required` to allow the regression script to provide its own target.

## Add Dependabot auto-merge

```yaml
name: Dependabot Auto-Merge

on:
  pull_request:
    branches: [main]

jobs:
  auto-merge:
    uses: The-Adult-In-The-Room/ci-workflows/.github/workflows/dependabot-auto-merge.yml@v2.1.1
    secrets: inherit
```

## Dependabot configuration

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      ci-workflows:
        patterns:
          - "The-Adult-In-The-Room/ci-workflows/*"
      actions:
        patterns:
          - "actions/*"
        exclude-patterns:
          - "The-Adult-In-The-Room/ci-workflows/*"
```

## Branch protection

Require the `CI / verify` check to pass before merging. If you use `deploy-and-smoke.yml`, you may also require `CI / deploy` and `CI / smoke`, but do **not** require `CI / rollback` — it only runs when `smoke` fails.

Do **not** require `CI / lighthouse`. It needs the `LHCI_GITHUB_APP_TOKEN` secret, and Dependabot PRs have no access to repository secrets. `verify.yml` skips `lighthouse` for Dependabot and ignores its result in the `CI / verify` merge gate, so it is purely an advisory signal.

## Standard check names

When the caller job is named `CI`, these checks are reported:

- `CI / lint-and-test`
- `CI / acceptance`
- `CI / verify`
- `CI / deploy` (from `deploy-and-smoke.yml`)
- `CI / smoke` (from `smoke.yml` or `deploy-and-smoke.yml`)
- `CI / rollback` (from `deploy-and-smoke.yml`, only on failure)
- `CI / regression`
- `CI / lighthouse`

## Inputs reference

See each workflow file in `.github/workflows/` for the full list of `workflow_call` inputs. Common ones:

- `verify.yml`: `run-lighthouse` (boolean, default `false`)
- `deploy-and-smoke.yml`: `project` (string, required), `service` (string, required), `environment` (string, default `production`), `url` (string, optional)
- `regression.yml`: `base-url` (string, default `""`), `base-url-required` (boolean, default `false`)

## Need help?

Open an issue in `The-Adult-In-The-Room/ci-workflows` (not your consumer repo) if the reusable workflow contract changes or checks fail unexpectedly.
