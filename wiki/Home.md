Welcome to the `The-Adult-In-The-Room/ci-workflows` wiki.

This repository is the single source of truth for reusable GitHub Actions workflows and composite actions shared across our projects. Treat its interface as a published API: consumers pin to immutable semver tags, and check names are part of the public contract.

> **Edits belong in the main repo.** These pages are auto-published from the `wiki/` directory in `The-Adult-In-The-Room/ci-workflows`. Edit the source files there; changes are pushed to this wiki on every merge to `main` and on every published release.

## Guides

- [Consumer Guide](Consumer-Guide) — how to add these workflows to your repository
- [Release Process](Release-Process) — how to cut a new semver release
- [Troubleshooting](Troubleshooting) — common failures and how to fix them
- [Migration Notes](Migration-Notes) — template and history for breaking changes

## Quick links

- Repository: `The-Adult-In-The-Room/ci-workflows`
- Consumer repos: `blog`, `portfolio`, `poe2-tools`
- Standards: see `AGENTS.md` in the repository root
