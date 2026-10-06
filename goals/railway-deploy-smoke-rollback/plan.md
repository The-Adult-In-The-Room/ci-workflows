# Plan: Railway deploy + smoke + rollback workflow

## Solution approach

Add a new reusable workflow, `deploy-and-smoke`, to `ci-workflows`. It accepts per-consumer Railway identifiers, deploys the current commit with `railway up --detach --json`, polls the deployment to `SUCCESS`, discovers the public URL, runs the existing `smoke.yml` suite against that URL, and — on smoke failure — checks out the previous successful commit and redeploys it with `railway up`.

Because Railway's CLI cannot perform a dashboard-style image+variable rollback, the "rollback" is a rebuild of the previous deployment. That limitation is documented in the workflow comments and in the consumer migration notes.

## Ordered steps

### 1. Add `base-url` input to `smoke.yml`

**Files:** `.github/workflows/smoke.yml`

- Add an optional `base-url` input (`type: string`, default `""`).
- When `base-url` is non-empty, set a `SMOKE_BASE_URL` environment variable for the `playwright-test` composite action step.
- This keeps `smoke.yml` backwards-compatible; callers that do not pass `base-url` continue to run smoke scripts against their default target.

**Verification:**
- `npm run contract` passes.
- Existing consumers that call `smoke.yml` without `base-url` are unaffected.

### 2. Create `.github/workflows/deploy-and-smoke.yml`

**Files:** `.github/workflows/deploy-and-smoke.yml`

- Trigger: `workflow_call` only. Consumers trigger it on pushes to `main` through their own caller workflows.
- Inputs:
  - `project` (string, required)
  - `service` (string, required)
  - `environment` (string, default `production`)
  - `smoke-command` (string, default `test:e2e:smoke`)
  - `url` (string, default `""`) — optional explicit smoke target URL
  - `deploy-timeout` (number, default `10`) — minutes to wait for deployment success
- Secrets:
  - `railway-token` (required, described)
- Jobs:
  1. `deploy` job:
     - Install the Railway CLI (e.g., `npm install -g @railway/cli`).
     - Authenticate via `RAILWAY_TOKEN` env var from `secrets.railway-token`.
     - Record the previous successful deployment's commit hash before deploying.
     - Run `railway up --detach --project <project> --service <service> --environment <environment> --json`.
     - Capture the new deployment ID from the final JSON line.
     - Poll `railway deployment list --json` until the new deployment status is `SUCCESS` or `deploy-timeout` expires.
     - If deployment fails/times out, fail the job. Do **not** run smoke tests or roll back.
     - Discover the deployed URL via `railway domain --json` unless the `url` input is provided.
     - Expose outputs: `deployment-id`, `previous-commit-hash`, `url`.
  2. `smoke` job:
     - `needs: deploy-and-smoke`
     - Calls `./.github/workflows/smoke.yml` (or the full `The-Adult-In-The-Room/ci-workflows/.github/workflows/smoke.yml@vX.Y.Z` reference) with `command` and `base-url`.
  3. `rollback` job:
     - `needs: [deploy, smoke]`
     - `if: failure() && needs.smoke.result == 'failure' && needs.deploy.outputs.previous-commit-hash != ''`
     - Checks out the previous successful commit captured by the `deploy` job.
     - Re-authenticates with Railway CLI.
     - Runs `railway up --detach --json` from the previous commit.
     - Polls until the new rollback deployment reaches `SUCCESS`.
     - The overall workflow still fails because smoke tests failed; the rollback is mitigation, not success.

**Verification:**
- `npm run contract` passes.
- `npm test` passes.
- No relative `uses:` in composite actions.
- All `workflow_call` inputs declare `type` and either `default` or `required: true`.
- Required secret has a `description`.

### 3. Update contract fixtures/tests if needed

**Files:** `scripts/contract-check.test.mjs`, `scripts/fixtures/*.yml` (if necessary)

- If the new workflow exercises a contract edge case not covered, add a fixture and an assertion.
- Otherwise, rely on the existing "real workflows satisfy every rule" test.

**Verification:**
- `npm test` passes.

### 4. Cut a release

**Files:** `.github/workflows/*.yml` (internal self-refs), git tags

- Choose a minor version bump (e.g., `v2.1.0`) because this is an additive change and `smoke.yml` gains only an optional input.
- Update any internal `The-Adult-In-The-Room/ci-workflows/…@<tag>` references to the new tag in the same commit.
- Create an exact semver tag; never move it after publishing.

**Verification:**
- `npm test && npm run contract` passes on the release commit.
- The new tag resolves and contains the new workflow.

### 5. Add consumer caller workflows

**Files:** in `blog`, `portfolio`, and `poe2-tools`: `.github/workflows/deploy.yml` (or similar)

Each consumer:

1. Creates `.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  CI:
    uses: The-Adult-In-The-Room/ci-workflows/.github/workflows/deploy-and-smoke.yml@v2.1.0
    with:
      project: ${{ vars.RAILWAY_PROJECT }}
      service: ${{ vars.RAILWAY_SERVICE }}
      environment: production
    secrets:
      railway-token: ${{ secrets.RAILWAY_TOKEN }}
```

2. Removes the old `.github/workflows/smoke.yml` that only ran smoke tests post-merge, since `deploy-and-smoke` now runs smoke tests after deploying.
3. Updates the Playwright smoke config to read `SMOKE_BASE_URL` and skip the local web server when it is set.
4. Stores `RAILWAY_PROJECT` and `RAILWAY_SERVICE` as repository variables (not secrets) so they are visible in the workflow file.
5. Stores `RAILWAY_TOKEN` as a repository secret.

**Verification:**
- A merge to `main` triggers the deploy-and-smoke workflow.
- The check name `Deploy / CI` appears on the commit.
- Branch protection is updated from the old `Smoke Tests / CI` to `Deploy / CI`.

## Risks and open questions

1. **Railway CLI JSON output shape is not guaranteed.** The plan assumes `railway up --detach --json` emits the deployment ID and `railway deployment list --json` includes status and ID. These shapes should be verified against the installed CLI version before release; a sample run with a real token is the only reliable validation.
2. **Rollback is a rebuild, not a true rollback.** Railway's dashboard can restore a previous image and variables instantly. Because the CLI's `redeploy` command cannot target a specific deployment ID, the workflow instead checks out the previous successful commit and runs `railway up` again. This rebuilds from the previous source with the current environment variables. Document this clearly so on-call engineers know the recovery time is a full rebuild, not an instant swap.
3. **Manual deploys are intentionally out of scope.** The reusable workflow uses `workflow_call` only. If manual deploys are needed later, each consumer can add `workflow_dispatch` to its own caller workflow without changing `ci-workflows`.
4. **Smoke tests must be URL-aware.** Consumers currently running `test:e2e:smoke` against a local server need to update their smoke scripts to honor `SMOKE_BASE_URL`. This is a consumer-side change and must be communicated as part of the rollout.
5. **URL discovery may need a fallback.** If `railway domain --json` does not return the expected shape for a given service, the optional `url` input provides an escape hatch.
6. **Redeploying during a rollback could itself fail.** The rollback depends on the previous successful commit still being available in the repository and being buildable. If that commit is no longer reachable (e.g., after a force-push) or its build no longer works with current Railway settings, the rollback deployment can fail. The workflow fails loudly in that case so a human can intervene via the dashboard.
