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
