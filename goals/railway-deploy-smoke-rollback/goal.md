# Goal: Railway deploy + smoke + rollback workflow

Add a reusable `deploy-and-smoke` workflow to `The-Adult-In-The-Room/ci-workflows` that deploys a consumer's `main` branch to Railway via the CLI, waits for the deployment to succeed, runs the existing smoke e2e suite against the live URL, and — if smoke tests fail — checks out the previous successful commit and redeploys it. Consumers keep their own Railway project and service settings in repository variables and pass their `RAILWAY_TOKEN` secret.

## Shared understanding

See [`facts.md`](./facts.md) for the accepted facts.

## Execution plan

See [`plan.md`](./plan.md) for the ordered implementation steps, verification commands, and risks.

## Done condition

- `deploy-and-smoke.yml` is merged to `main` and satisfies `npm test && npm run contract`.
- `smoke.yml` has been extended with an optional `base-url` input in a backwards-compatible way.
- A semver release tag (e.g., `v2.1.0`) exists and internal self-references point to it.
- Each consumer repo (`blog`, `portfolio`, `poe2-tools`) has a caller workflow that triggers on pushes to `main` and runs the new reusable workflow with its own Railway settings.
