# Consumer caller workflow templates

Add one of these files to each consumer repo at `.github/workflows/deploy.yml`.

## Template

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy-and-smoke:
    uses: The-Adult-In-The-Room/ci-workflows/.github/workflows/deploy-and-smoke.yml@v2.1.0
    with:
      project: ${{ vars.RAILWAY_PROJECT }}
      service: ${{ vars.RAILWAY_SERVICE }}
      environment: production
    secrets:
      railway-token: ${{ secrets.RAILWAY_TOKEN }}
```

## Required repository settings

| Setting | Kind | Purpose |
|---------|------|---------|
| `RAILWAY_PROJECT` | Repository variable | Railway project ID or name. |
| `RAILWAY_SERVICE` | Repository variable | Railway service ID or name. |
| `RAILWAY_TOKEN` | Repository secret | Railway project token with deploy access. |

## Consumer smoke script changes

The `deploy-and-smoke` workflow passes the live URL to `smoke.yml` via the `base-url` input, which sets the `SMOKE_BASE_URL` environment variable. Update each consumer's `test:e2e:smoke` script (or the Playwright config it uses) to read `SMOKE_BASE_URL` and fall back to the local dev server when it is empty:

```ts
// playwright.config.ts
const baseURL = process.env.SMOKE_BASE_URL || 'http://localhost:4321';

export default defineConfig({
  use: { baseURL },
});
```

## Check name

The caller job is named `deploy-and-smoke`, so the required check name for branch protection is `CI / deploy-and-smoke` (assuming the workflow file itself is named `Deploy`).
