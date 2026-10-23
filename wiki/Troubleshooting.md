Common problems when working with `ci-workflows`.

## Composite action uses a relative path

**Symptom:** `Error: Can't find 'action.yml'`

**Cause:** Composite actions run in the consumer's checkout. `uses: ./.github/actions/...` resolves to the wrong repo.

**Fix:** Always use the full repository reference with an immutable tag:

```yaml
uses: The-Adult-In-The-Room/ci-workflows/.github/actions/setup-node@v2.2.0
```

## Internal refs still point to an old tag

**Symptom:** A workflow or action behaves like the previous release.

**Fix:** Search the repo for stale references:

```bash
rg "The-Adult-In-The-Room/ci-workflows/.github/.+@v"
```

Update any that do not match the latest release tag.

## Contract check fails

**Symptom:** `npm run contract` reports a rule violation.

**Common causes:**

- A `workflow_call` input lacks `type`
- A `workflow_call` input is used in `run:` or `with:` but has no `default` and is not `required: true`
- A required secret has no `description`
- A composite action uses `uses: ./...`
- An artifact name interpolates a raw input
- Internal refs point to a branch instead of a tag

## Branch protection shows missing checks

**Symptom:** PRs cannot merge because required status checks are stuck.

**Cause:** Check names are a public API. If a job or step name changes, the required check name in branch protection no longer matches.

**Fix:** Keep check names stable:

- `CI / lint-and-test`
- `CI / acceptance`
- `CI / verify`
- `CI / create-deployment`
- `CI / deploy`
- `CI / smoke`
- `CI / rollback`
- `CI / deployment-status`
- `CI / regression`
- `CI / lighthouse`

If you rename one, update branch protection in every consumer repo.

## Smoke tests run but the deployment never happens

**Symptom:** The `CI / smoke` check passes or fails, but nothing was deployed.

**Cause:** `smoke.yml` only runs the smoke test suite against a URL. It does not deploy anything. The deploy-and-smoke orchestration lives in `deploy-and-smoke.yml`.

**Fix:** For post-merge deploy + smoke + rollback, use `deploy-and-smoke.yml`. Use `smoke.yml` only when you already have a URL to test against.

## Lighthouse job fails

**Symptom:** `lighthouse.yml` reports assertion errors.

**Fix:** Check the Lighthouse CI assertions in your consumer repo. The reusable workflow only runs Lighthouse CI; the budget/assertion config lives in the consumer.

## e2e tests fail in CI but pass locally

**Symptom:** Playwright/Lightpanda tests time out or behave differently.

**Common causes:**

- Missing `npm run build` output
- Tests rely on a dev server instead of a production build
- Lightpanda does not support the browser API the test uses

**Fix:** Ensure acceptance e2e runs against a local build or a properly started dev server. Check Lightpanda compatibility for non-standard APIs.

## Dependabot does not group ci-workflows bumps

**Symptom:** Each `ci-workflows` release creates a separate Dependabot PR.

**Fix:** Use the Dependabot group pattern exactly:

```yaml
groups:
  ci-workflows:
    patterns:
      - "The-Adult-In-The-Room/ci-workflows/*"
```

## Dependabot auto-merge fails with "Wait for check" exit code 1

**Symptom:** `CI / auto-merge` fails about a minute after the PR is opened, before `CI / verify` has had a chance to run.

**Cause:** You are pinned to v2.x, which polls for the `CI / verify` check run from PR-open time. `CI / verify` is a rollup job that only exists once the verify suite is nearly finished, so the poller's discovery timeout is racing the entire suite duration. No `checks-discovery-timeout` value fixes that.

**Fix:** Upgrade to v3.0.0, which replaces polling with a `workflow_run` trigger: the auto-merger runs after the verify workflow completes. See the [Migration Notes](https://github.com/The-Adult-In-The-Room/ci-workflows/wiki/Migration-Notes) for the v2 → v3 checklist.

## Dependabot PR does not merge after verify passes

**Check:**

- The auto-merge caller triggers on `workflow_run` of the verify workflow (`types: [completed]`), and the `workflows:` list matches the verify caller workflow's `name:` exactly. Callers still on `pull_request_target` fail with migration instructions in the run log.
- **Allow auto-merge** is enabled in the repository settings.
- The `CI / auto-merge` run log: it prints the source run conclusion, each candidate PR with its state and author, and why it skipped when it does.

## GitHub Deployment is not created

**Symptom:** `CI / create-deployment` fails with `Resource not accessible by integration` or the repository's Deployments page shows nothing after a deploy.

**Cause:** The caller workflow does not grant `deployments: write` (and, because the smoke job uploads failure artifacts, `actions: write`) to the reusable workflow.

**Fix:** Add the required permissions to the `deploy-and-smoke.yml` caller:

```yaml
permissions:
  contents: read
  deployments: write
  actions: write
```

See the [Consumer Guide](https://github.com/The-Adult-In-The-Room/ci-workflows/wiki/Consumer-Guide) for a complete example.

## Still stuck?

Open an issue in `The-Adult-In-The-Room/ci-workflows` with:

- The failing workflow run link
- The tag you are pinned to
- The relevant snippet from the consumer caller
