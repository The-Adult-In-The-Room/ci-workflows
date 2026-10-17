How to publish a new version of `ci-workflows`.

## Automated release (recommended)

The [Release workflow](https://github.com/The-Adult-In-The-Room/ci-workflows/actions/workflows/release.yml) automates the mechanical parts: validating the version, rewriting internal refs, running the contract check and tests, committing, tagging, and pushing.

### Via the GitHub UI

1. Go to [Actions → Release](https://github.com/The-Adult-In-The-Room/ci-workflows/actions/workflows/release.yml)
2. Click **Run workflow**
3. Choose a `bump` keyword (`patch`, `minor`, `major`, etc.) or enter an explicit `version`
4. For pre-releases, optionally set `preid` (e.g. `beta`, `rc`)
5. Click **Run workflow**

The workflow will:
- Validate the version is a valid semver bump over the latest tag
- Rewrite every `The-Adult-In-The-Room/ci-workflows/...@<tag>` ref under `.github/`
- Run `npm run contract` and `npm test`
- Commit with `[skip ci]`, create an annotated tag, and push
- Create a GitHub Release with auto-generated release notes at `https://github.com/The-Adult-In-The-Room/ci-workflows/releases`

### Via the CLI

```bash
# Preview what would change (no commit)
npm run release minor

# Stage, commit, and tag — but do not push (caller controls the push)
npm run release minor -- --commit

# Commit, tag, and push (uses your local git credentials)
npm run release minor -- --push

# Explicit version
npm run release v2.3.0 -- --push

# Pre-release
npm run release preminor -- --preid beta --push
```

### What the workflow guarantees

The release script closes the gap that rule 2 of the contract checker cannot see: it verifies that every internal self-reference equals the tag just cut. If any ref disagrees, the script exits non-zero before the tag reaches consumers.

The script also runs the contract check and tests after rewriting, so a release that breaks the contract fails before it pushes.

### Authentication (required)

The workflow **requires** a `RELEASE_TOKEN` secret — a GitHub Personal Access Token (PAT). The automatic `GITHUB_TOKEN` cannot be used because:

1. **`workflows` permission** — The release commit modifies files under `.github/workflows/` (it bumps every internal self-reference). `GITHUB_TOKEN` is a GitHub App installation token, and by default GitHub Apps cannot create or update workflow files. A PAT with the `workflow` scope can.

2. **Branch protection bypass** — The release commit carries `[skip ci]` so it does not re-trigger Self Check (the workflow has already run the contract check and tests inline). This means the commit does not produce the status checks the branch protection ruleset requires. The PAT owner must be a repository admin or be listed as a bypass actor in the ruleset, so the push is allowed through.

#### Creating the PAT

1. Go to [GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/tokens?type=beta) (or classic tokens)
2. Create a new token with:
   - **`repo`** scope (full control of private repositories)
   - **`workflow`** scope (required to update workflow files)
3. Add the token as a repository secret named `RELEASE_TOKEN` in [Settings → Secrets and variables → Actions](https://github.com/The-Adult-In-The-Room/ci-workflows/settings/secrets/actions)

#### Branch protection bypass

The PAT owner must be able to bypass the branch protection rules on `main`. Either:

- The PAT owner is a repository admin (admins bypass rules by default), **or**
- The PAT owner is listed as a bypass actor in the ruleset at [Settings → Rules → Rulesets](https://github.com/The-Adult-In-The-Room/ci-workflows/settings/rules)

If the push fails with `GH013: Repository rule violations found`, the PAT owner lacks bypass permission. Either promote them to admin, or add them to the ruleset's bypass list.

## Manual release (fallback)

If the automated workflow is unavailable or you need fine-grained control:

### 1. Decide the version bump

Follow [Semantic Versioning](https://semver.org/):

- **Patch (`v1.0.1`)** — bug fixes, non-breaking internal ref updates
- **Minor (`v1.1.0`)** — new features, new optional inputs, backwards-compatible
- **Major (`v2.0.0`)** — renamed inputs, changed defaults, renamed checks, dropped support

Any change that requires consumers to update their caller workflows, npm scripts, or branch protection rules is a **breaking change**.

### 2. Update internal self-references

In the same commit, update every internal reference from the old tag to the new tag:

```bash
# Example: bumping from v1.0.1 to v1.0.2
rg "The-Adult-In-The-Room/ci-workflows/.github/.+@v1\.0\.1"
```

Files that usually contain self-references:

- `.github/workflows/verify.yml`
- `.github/workflows/deploy-and-smoke.yml`
- `.github/workflows/smoke.yml`
- `.github/workflows/regression.yml`
- `.github/workflows/dependabot-auto-merge.yml`
- `.github/workflows/lighthouse.yml`
- Composite actions under `.github/actions/*/action.yml`
- Any workflow that calls another workflow or composite action in this repo

### 3. Run validation

```bash
npm test
npm run contract
```

Both must pass. The contract checker enforces rules that `actionlint` cannot see.

### 4. Verify self-references match

After rewriting, verify every internal ref equals the new tag:

```bash
node scripts/release.mjs v1.1.0
```

The script will report any mismatches. If all refs match, it exits 0.

### 5. Commit and push

Use a clear commit message, e.g.:

```
release: cut v1.1.0

- add optional `node-version` input to setup-node
- update all internal refs to v1.1.0
```

### 6. Create an exact semver tag

```bash
git tag v1.1.0
git push origin main v1.1.0
```

### 7. Create a GitHub Release

After pushing the tag, create a GitHub Release with auto-generated notes:

```bash
gh release create v1.1.0 \
  --title "Release v1.1.0" \
  --generate-notes \
  --latest
```

This creates a release at `https://github.com/The-Adult-In-The-Room/ci-workflows/releases` with notes auto-generated from commits since the previous tag.

### 8. Never move a published tag

Once pushed, the tag is immutable. If you discover a problem, cut a new patch release.

## For major versions

1. Write migration notes in the wiki (see `Migration-Notes.md`).
2. Open tracking issues in consumer repos (`blog`, `portfolio`, `poe2-tools`).
3. Do **not** update consumers automatically; let them opt in via reviewed PRs.

## Checklist

- [ ] Version bump determined correctly (or chosen via the workflow UI)
- [ ] All internal refs updated to the new tag (automated by the workflow)
- [ ] `npm test` passes (automated by the workflow)
- [ ] `npm run contract` passes (automated by the workflow)
- [ ] Post-cut verification confirms every ref equals the new tag (automated by the workflow)
- [ ] Tag created and pushed exactly once (automated by the workflow)
- [ ] GitHub Release created with auto-generated notes (automated by the workflow)
- [ ] Wiki updated if needed (source files are in `wiki/`; `publish-wiki.yml` syncs them on push to `main` and on published releases)
- [ ] Consumer migration issues opened for major releases
