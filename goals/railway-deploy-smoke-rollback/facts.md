# Facts

- A new reusable workflow named deploy-and-smoke exists at .github/workflows/deploy-and-smoke.yml in ci-workflows.
- The workflow triggers on workflow_call only.
- Required inputs are project (string), service (string), and railway-token (secret).
- Optional inputs are environment (string, default production), smoke-command (string, default test:e2e:smoke), url (string, default empty for auto-discovery), and deploy-timeout (number, default 10 minutes).
- The workflow installs the Railway CLI and authenticates with RAILWAY_TOKEN from the provided secret.
- The workflow runs railway up --detach --project <project> --service <service> --environment <environment> --json to create a deployment without blocking on logs.
- The workflow captures the new deployment ID from the railway up --json output.
- The workflow polls railway deployment list --json until the captured deployment reaches SUCCESS or the deploy-timeout expires.
- If the deployment does not reach SUCCESS, the workflow fails without running smoke tests and does not attempt rollback.
- After SUCCESS, the workflow discovers the deployed service URL via railway domain --json unless the url input is provided.
- The workflow calls smoke.yml with the smoke-command input, exposing the discovered URL as an environment variable.
- If smoke tests fail, the workflow checks out the previous successful commit and redeploys it with railway up, documenting that this is a rebuild from the previous source with current variables, not a dashboard image+variable rollback.
- Each consumer caller workflow is named Deploy with a CI job, exposing a stable check name Deploy / CI for branch protection.
- The workflow sets outputs for deployment-id, previous-commit-hash, and url.
- The workflow passes npm test and npm run contract validation before any release.
- Internal references to ci-workflows reusable workflows and composite actions use immutable semver tags.
- Each consumer repo owns a caller workflow triggered on push to main that invokes the deploy-and-smoke reusable workflow with its own Railway project/service settings.
