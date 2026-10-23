# Canary System

The canary system is an automated testing infrastructure that validates changes to reusable workflows before they're released. It runs the affected workflows in a controlled environment (the `blog` repo) to catch interface-breaking changes early.

## Overview

When you open a PR in `ci-workflows`, the canary system:

1. Analyzes which files changed
2. Determines which workflows need testing (selective dispatch)
3. Moves a `canary` tag to the PR commit
4. Dispatches to the `blog` repo to run those workflows
5. Reports results back as status checks on your PR

This catches bugs like:
- Interface changes that break consumers
- Missing or misconfigured secrets
- Cross-repo workflow reference errors
- Script name mismatches

## How It Works

### The Flow

```
PR opens in ci-workflows
    ↓
Canary Dispatcher runs (_canary-dispatcher.yml)
    ↓
Scripts/canary-scope.mjs analyzes changed files
    ↓
Determines targets (verify, lighthouse, deploy, or combinations)
    ↓
Moves canary tag to PR commit
    ↓
Dispatches to blog via repository_dispatch
    ↓
Blog runs workflows at @canary tag
    ↓
Results posted back as status checks
```

### Selective Dispatch

The canary system uses `.github/_canary-map.yml` to determine which workflows to test:

| Changed File | Canary Target |
|-------------|---------------|
| `verify.yml`, `regression.yml` | verify only |
| `lighthouse.yml` | lighthouse only |
| `deploy-and-smoke.yml`, `smoke.yml` | deploy only |
| `_canary-dispatcher.yml` | verify, lighthouse, and deploy |
| `playwright-test/**`, `setup-node/**` | verify and deploy |
| Internal workflows (`_*.yml`) | neither (skip canary) |
| Safe files (README, package.json, etc.) | neither (skip canary) |
| Unknown files | all three targets (fail-safe) |
| `_canary-map.yml` itself | all three targets (fail-safe) |

**Fail-safe behavior**: If a changed file doesn't match any rule, the canary runs both targets. This prevents accidentally skipping tests when someone adds a new workflow without updating the map.

### Permissions

The canary workflow runs reusable workflows from the consumer repo, so it must grant the permissions those workflows request.

- **`canary / deploy`** calls `deploy-and-smoke.yml`, which creates GitHub Deployments and uploads smoke artifacts. The deploy job needs:

  ```yaml
  permissions:
    contents: read
    deployments: write
    actions: write
  ```

- **`canary / verify`** and **`canary / lighthouse`** do not require extra permissions beyond the repository defaults.

If a reusable workflow requests a permission the canary caller does not grant, the dispatch fails with `The workflow is requesting '...', but is only allowed '... none'`.

## Status Checks

Every PR gets status checks for all three canary targets:

- **`canary / verify`** — runs lint, test, and acceptance e2e
- **`canary / lighthouse`** — runs Lighthouse CI performance audits
- **`canary / deploy`** — runs deploy-and-smoke against Railway canary environment

These checks are always present, even when they're not needed. If a target is skipped, it posts a "skipped" status with a success state. This allows the canary checks to be required in branch protection rules.

### Status Check States

- **Success** — workflow passed or was skipped (no relevant changes)
- **Failure** — workflow failed (interface-breaking change detected)
- **Pending** — workflow is running

## Manual Testing

If you need to test a specific commit without opening a PR:

```bash
# Test current HEAD
node scripts/canary-test.mjs

# Test a specific commit
node scripts/canary-test.mjs <commit-sha>
```

This script:
1. Moves the `canary` tag to the specified commit
2. Dispatches to the blog repo
3. Triggers the canary workflow

**Note**: Manual tests don't post status checks back to a PR. Check the blog repo's Actions tab to see results.

## Configuration Files

### `.github/_canary-map.yml`

Maps file paths to canary targets. Structure:

```yaml
rules:
  - targets: [verify]
    paths:
      - .github/workflows/verify.yml
      - .github/workflows/regression.yml
  
  - targets: [lighthouse]
    paths:
      - .github/workflows/lighthouse.yml
  
  - targets: [deploy]
    paths:
      - .github/workflows/deploy-and-smoke.yml
      - .github/workflows/smoke.yml
  
  - targets: [verify, deploy]
    paths:
      - .github/actions/**
  
  - targets: []
    paths:
      - .github/workflows/_*.yml
      - README.md
      - package.json
      # ... other safe files
```

### `scripts/canary-scope.mjs`

Computes which targets to run based on changed files. Reads the diff and `_canary-map.yml`, then outputs a JSON array of targets.

### `.github/workflows/_canary-dispatcher.yml`

Orchestrates the canary system:
1. Runs `canary-scope.mjs` to determine targets
2. Posts "skipped" status for targets that won't run
3. Moves the `canary` tag to the PR commit
4. Dispatches to the blog repo

## Branch Protection

The canary checks can be required in branch protection rules. Because they always post status checks (even when skipped), PRs won't be blocked by missing checks.

To require canary checks:
1. Go to Settings → Rules → Rulesets
2. Add `canary / verify`, `canary / lighthouse`, and `canary / deploy` to required status checks
3. Apply to `main` branch

## Troubleshooting

### Canary runs both targets even though I only changed one workflow

Check if the changed file is in `_canary-map.yml`. If it's not explicitly listed, the fail-safe runs both targets.

**Solution**: Add the file to the appropriate rule in `_canary-map.yml`.

### Canary says "skipped" but I expected it to run

Check the dispatcher logs to see what targets were computed:

```bash
gh run view <run-id> --log | grep "Computed targets"
```

If it shows `[]`, no targets matched. Check the dispatcher logs for "Changed files" to see what the script detected.

### Blog workflow fails but PR shows success

This shouldn't happen with the current setup. Check:
1. Blog workflow logs (link is in the status check details)
2. Blog's `Report canary status` job logs
3. The `canary` tag — is it pointing to the right commit?

### Manual test doesn't post status checks

That's expected. Manual tests use `scripts/canary-test.mjs`, which doesn't post status checks. Check the blog repo's Actions tab to see results.

## Related Issues

- #6 — Initial canary system implementation
- #41 — Contract-checker enforcement of canary-map.yml coverage
- #42 — Add Lighthouse as a canary target

## Architecture Decisions

### Why a separate repo (blog)?

The canary needs to run reusable workflows, which requires being called from a consumer repo. We can't call workflows from the same repo that defines them. The blog repo is the test consumer.

### Why a `canary` tag instead of passing the ref?

GitHub Actions doesn't allow expressions in the `uses` field for reusable workflows. The ref must be a literal. Using a movable tag lets us dynamically test different commits while keeping the `uses` field static.

### Why serialize dispatches?

Multiple PRs opening simultaneously could race to move the `canary` tag. The concurrency group ensures only one dispatch runs at a time, preventing tag conflicts.

### Why post "skipped" status?

Branch protection requires all checks to be present. If we only posted status for targets that ran, PRs without relevant changes would be blocked. Posting "skipped" with a success state satisfies branch protection while clearly indicating what ran.
