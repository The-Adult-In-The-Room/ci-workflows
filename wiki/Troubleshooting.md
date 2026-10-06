Common problems when working with `ci-workflows`.

## Composite action uses a relative path

**Symptom:** `Error: Can't find 'action.yml'`

**Cause:** Composite actions run in the consumer's checkout. `uses: ./.github/actions/...` resolves to the wrong repo.

**Fix:** Always use the full repository reference with an immutable tag:

```yaml
uses: The-Adult-In-The-Room/ci-workflows/.github/actions/setup-node@v2.1.1
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
- `CI / deploy`
- `CI / smoke`
- `CI / rollback`
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

## Still stuck?

Open an issue in `The-Adult-In-The-Room/ci-workflows` with:

- The failing workflow run link
- The tag you are pinned to
- The relevant snippet from the consumer caller
