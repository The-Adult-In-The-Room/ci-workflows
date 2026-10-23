Template and history for breaking changes.

## Template: vX.Y.Z → v(X+1).0.0

### Breaking changes

- Renamed input `old-input` → `new-input`
- Changed default of `run-lighthouse` from `false` to `true`
- Renamed job/check from `CI / lint` to `CI / lint-and-test`

### Consumer update checklist

- [ ] Update all `The-Adult-In-The-Room/ci-workflows/...` references to `v(X+1).0.0`
- [ ] Rename any `old-input` usages to `new-input`
- [ ] Review whether the new default for `run-lighthouse` is acceptable
- [ ] Update branch protection required checks from `CI / lint` to `CI / lint-and-test`
- [ ] Run `npm run verify` and `npm run build` locally
- [ ] Open a PR and confirm `CI / verify` passes

### Example diff

```yaml
# Before
jobs:
  verify:
    uses: The-Adult-In-The-Room/ci-workflows/.github/workflows/verify.yml@v1.0.0
    with:
      old-input: true

# After
jobs:
  verify:
    uses: The-Adult-In-The-Room/ci-workflows/.github/workflows/verify.yml@v2.0.0
    with:
      new-input: true
```

---

## Past migrations

### v3.x → v4.0.0

`deploy-and-smoke.yml` now creates a GitHub Deployment for every deploy and updates its status through the lifecycle.

- Breaking change
  - The caller **must** grant `deployments: write` and `actions: write` permissions. `deployments: write` is required to create deployments and statuses; `actions: write` is required because the smoke job uploads Playwright failure artifacts. Without them, the workflow fails with `Resource not accessible by integration`.
- New behavior
  - A `create-deployment` job creates a GitHub Deployment for `github.sha` in the environment named by the `environment` input (default `production`).
  - Deployment status moves through `queued` → `in_progress` → `success` or `failure`.
  - On success, the deployment links to the discovered or explicit `url`.
  - If smoke tests fail and rollback succeeds, the deployment is still marked `failure` with a description that notes the rollback.
- New check names
  - `CI / create-deployment` (always reported)
  - `CI / deployment-status` (always reported)
- Consumer update checklist
  - [ ] Update all `The-Adult-In-The-Room/ci-workflows/...` references to `v4.0.0`.
  - [ ] Add `permissions` to the `deploy-and-smoke.yml` caller:

    ```yaml
    permissions:
      contents: read
      deployments: write
      actions: write
    ```

  - [ ] Confirm branch protection still requires `CI / verify` (and optionally `CI / deploy` / `CI / smoke`).
  - [ ] Do **not** require `CI / create-deployment` or `CI / deployment-status`.

### v2.x → v3.0.0

`dependabot-auto-merge.yml` is now event-driven: it runs when the verify workflow completes instead of polling for the `CI / verify` check run from PR-open time.

- Breaking changes
  - The caller trigger must change from `pull_request_target` to `workflow_run` on the verify caller workflow, `types: [completed]`. Callers that keep the old trigger fail loudly with migration instructions in the run log.
  - Removed inputs `check-name` and `checks-discovery-timeout`. There is no polling left to configure.
  - `lewagon/wait-on-check-action` is no longer used.
  - The merge is performed by enabling auto-merge (`gh pr merge --auto`), so the repository must have **Allow auto-merge** enabled.
- Why: `CI / verify` is a rollup job that only exists once the verify suite is nearly finished, so the v2.x poller's discovery timeout was racing the entire suite duration (see issue #60). No timeout value fixes that; the trigger had to change.
- Consumer update checklist
  - [ ] Enable **Allow auto-merge** in the repository settings.
  - [ ] Change the caller trigger to:

    ```yaml
    on:
      workflow_run:
        workflows: [<name of your verify caller workflow>]
        types: [completed]
    ```

  - [ ] Update the ref to `v3.0.0`.
  - [ ] Delete any `check-name` / `checks-discovery-timeout` inputs.
  - [ ] Confirm branch protection requires `CI / verify`.
  - [ ] Re-run the verify workflow on an open Dependabot PR and confirm it merges once `CI / verify` is green.
- Behavior notes
  - Verify runs triggered by `push` to the default branch also fire the trigger; the workflow finds no open Dependabot PR and exits green without merging.
  - A failed or cancelled verify run means no merge, by design. Re-running verify to green re-triggers the auto-merger.

### v1.x.x → v2.0.0

`verify.yml` now embeds an optional Lighthouse CI job.

- Breaking change
  - `verify.yml` gained new optional inputs (`run-lighthouse`, `build-command`, `lhci-command`) and a new secret (`lhci-github-app-token`).
  - A new check `CI / lighthouse` is reported when `run-lighthouse: true`.
  - The aggregate `CI / verify` job now fails if Lighthouse fails when enabled.
- Consumer update checklist
  - [ ] Update all refs to `v2.0.0`.
  - [ ] If you want Lighthouse CI in the PR gate, pass `run-lighthouse: true` and `secrets.lhci-github-app-token`.
  - [ ] If you do not want Lighthouse CI, omit `run-lighthouse` or set it to `false`.
  - [ ] Update branch protection to require `CI / verify`.

### v2.0.x → v2.1.0

New `deploy-and-smoke.yml` workflow; `smoke.yml` is now a URL-targeted primitive.

This is a backwards-compatible minor release, but the recommended consumer pattern changed.

- New workflow
  - `deploy-and-smoke.yml` deploys to Railway, runs smoke tests against the deployed URL, and rolls back on failure.
- Changed behavior
  - `smoke.yml` now accepts an optional `base-url` input. When empty, the smoke script uses its own default target.
  - The post-merge "deploy + smoke" orchestration moved from `smoke.yml` to `deploy-and-smoke.yml`.
- New check names
  - `CI / deploy`
  - `CI / rollback` (only runs when smoke tests fail)
- Consumer update checklist
  - [ ] Update all refs to `v2.1.0` (or the latest `v2.1.x` patch).
  - [ ] Replace the post-merge `smoke.yml` caller with `deploy-and-smoke.yml`.
  - [ ] Set `RAILWAY_PROJECT` and `RAILWAY_SERVICE` as repository variables.
  - [ ] Provide `secrets.RAILWAY_TOKEN` to `deploy-and-smoke.yml`.
  - [ ] Keep `npm run test:e2e:smoke` as the smoke script.
  - [ ] Optionally require `CI / deploy` and `CI / smoke` in branch protection; do **not** require `CI / rollback`.
