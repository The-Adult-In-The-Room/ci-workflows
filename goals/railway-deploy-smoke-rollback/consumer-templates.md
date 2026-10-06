# Consumer caller workflow templates

Add one of these files to each consumer repo at `.github/workflows/deploy.yml`.

## Template

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

## Required repository settings

| Setting | Kind | Purpose |
|---------|------|---------|
| `RAILWAY_PROJECT` | Repository variable | Railway project ID or name. |
| `RAILWAY_SERVICE` | Repository variable | Railway service ID or name. |
| `RAILWAY_TOKEN` | Repository secret | Railway project token with deploy access. |

## Consumer smoke script changes

The `deploy-and-smoke` workflow passes the live URL to `smoke.yml` via the `base-url` input, which sets the `SMOKE_BASE_URL` environment variable. Smoke tests should be deployment-only: the Playwright smoke config should require `SMOKE_BASE_URL` and not start a local preview server.

```ts
// playwright.smoke.config.ts
if (!process.env.SMOKE_BASE_URL) {
  throw new Error('SMOKE_BASE_URL is required for smoke tests');
}

export default defineConfig({
  use: { baseURL: process.env.SMOKE_BASE_URL },
  // ... other shared config
});
```

Update `test:e2e:smoke` to use the smoke-specific config, e.g.:

```json
{
  "test:e2e:smoke": "playwright test --config=playwright.smoke.config.ts"
}
```

## Check name

The workflow is named `Deploy` and the caller job is named `CI`, so the required check name for branch protection is `Deploy / CI`. Update branch protection to replace the old `Smoke Tests / CI` check.
