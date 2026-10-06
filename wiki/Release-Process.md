How to publish a new version of `ci-workflows`.

## 1. Decide the version bump

Follow [Semantic Versioning](https://semver.org/):

- **Patch (`v1.0.1`)** — bug fixes, non-breaking internal ref updates
- **Minor (`v1.1.0`)** — new features, new optional inputs, backwards-compatible
- **Major (`v2.0.0`)** — renamed inputs, changed defaults, renamed checks, dropped support

Any change that requires consumers to update their caller workflows, npm scripts, or branch protection rules is a **breaking change**.

## 2. Update internal self-references

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

## 3. Run validation

```bash
npm test
npm run contract
```

Both must pass. The contract checker enforces rules that `actionlint` cannot see.

## 4. Commit and push

Use a clear commit message, e.g.:

```
release: cut v1.1.0

- add optional `node-version` input to setup-node
- update all internal refs to v1.1.0
```

## 5. Create an exact semver tag

```bash
git tag v1.1.0
git push origin v1.1.0
```

## 6. Never move a published tag

Once pushed, the tag is immutable. If you discover a problem, cut a new patch release.

## 7. For major versions

1. Write migration notes in the wiki (see `Migration-Notes.md`).
2. Open tracking issues in consumer repos (`blog`, `portfolio`, `poe2-tools`).
3. Do **not** update consumers automatically; let them opt in via reviewed PRs.

## Checklist

- [ ] Version bump determined correctly
- [ ] All internal refs updated to the new tag
- [ ] `npm test` passes
- [ ] `npm run contract` passes
- [ ] Tag created and pushed exactly once
- [ ] Wiki updated if needed (source files are in `wiki/`; `publish-wiki.yml` syncs them on push to `main` and on published releases)
- [ ] Consumer migration issues opened for major releases
