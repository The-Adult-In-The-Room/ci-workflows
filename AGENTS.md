# CI/CD Standards for ci-workflows

This repository (`The-Adult-In-The-Room/ci-workflows`) is the single source of truth for reusable GitHub Actions workflows and composite actions shared across:

- `The-Adult-In-The-Room/blog`
- `The-Adult-In-The-Room/portfolio`
- `The-Adult-In-The-Room/poe2-tools`

Any change here propagates, via immutable semver tags, to every consumer. Treat the interface as a published API.

## Core principles

1. **Consumers pin to immutable semver tags, never branches.** A consumer reference looks like `The-Adult-In-The-Room/ci-workflows/.github/workflows/verify.yml@v1.0.1`.
2. **Internal self-references inside this repo must also be immutable tags or SHAs.** When cutting a release, update all `The-Adult-In-The-Room/ci-workflows/…@<tag>` refs in the same commit.
3. **Check names are a public API.** Keep them stable once consumers depend on them: `CI / lint-and-test`, `CI / acceptance`, `CI / verify`, `CI / smoke`, `CI / regression`, `CI / lighthouse`.
4. **Composite actions must never use relative `uses:` paths.** They run in the consumer's checkout, so `uses: ./...` resolves against the wrong repo.
5. **Artifact names must be filesystem-agnostic.** Never interpolate an input directly into an artifact name; derive a sanitized name in a step and forward `steps.<id>.outputs.<name>`.
6. **Inputs forwarded into execution must be safe to omit.** Every workflow_call input that reaches a `run:` or `with:` must either have a `default` or be `required: true`, and must declare a `type`.
7. **Required secrets must have descriptions.** Consumers cannot guess what to pass.

## Standard consumer shape

Each consumer repo should expose:

- `npm run verify` — typecheck, lint, format, unit tests
- `npm run build` — production build
- `test:e2e:acceptance` — acceptance e2e suite (runs against a local build or dev server)
- `test:e2e:smoke` — post-merge smoke e2e suite
- `test:e2e:regression` — scheduled regression suite against production
- `.nvmrc` — Node version
- Dependabot config that watches `github-actions` and groups `The-Adult-In-The-Room/ci-workflows` bumps separately from third-party actions.

## e2e testing

All e2e jobs use [Lightpanda](https://github.com/lightpanda-io/browser) for fast, consistent headless testing. The `playwright-test` composite action installs Lightpanda automatically.

## Workflows and actions in this repo

| Kind | Name | Path | Purpose |
|------|------|------|---------|
| Composite action | `setup-node` | `.github/actions/setup-node` | Install Node.js from `.nvmrc` and run `npm ci`. |
| Composite action | `playwright-test` | `.github/actions/playwright-test` | Install Lightpanda and run a Playwright e2e npm script. |
| Reusable workflow | `verify` | `.github/workflows/verify.yml` | PR gate: lint/test + acceptance e2e. |
| Reusable workflow | `smoke` | `.github/workflows/smoke.yml` | Post-merge smoke e2e tests. |
| Reusable workflow | `regression` | `.github/workflows/regression.yml` | Scheduled regression tests against a production URL. |
| Reusable workflow | `dependabot-auto-merge` | `.github/workflows/dependabot-auto-merge.yml` | Auto-merge Dependabot PRs after `CI / verify` passes. |
| Reusable workflow | `lighthouse` | `.github/workflows/lighthouse.yml` | Run Lighthouse CI against a build. |

## Contract validation

Before declaring any change complete, run:

```bash
npm test         # unit tests for the contract rules
npm run contract # validate .github/** against the contract rules
```

The contract checker lives in `scripts/contract-check.mjs` and enforces six rules that `actionlint` cannot see. It is a hard gate. Do not bypass it.

## Release process

When cutting a release:

1. Update internal `The-Adult-In-The-Room/ci-workflows/…@<tag>` refs to the new tag in the same commit.
2. Create an exact semver tag, e.g. `v1.0.2` or `v2.0.0`.
3. Never move a tag after publishing.
4. For breaking changes (renamed input, changed default, renamed check), cut a major version (`v2.0.0`) and let consumers opt in via reviewed PRs.

## Cross-repo consistency

When working in this repo, always ask: "How does this change affect blog, portfolio, and poe2-tools?" If a change requires consumers to update their inputs, scripts, or check names, it is a breaking change and needs a major version bump plus migration notes.

When applying these workflows in a consumer repo, ensure:

- The caller job is named `CI`.
- The reference uses an immutable semver tag.
- The consumer exposes the expected npm scripts and `.nvmrc`.
- Branch protection requires `CI / verify`.
- Dependabot is configured to bump `github-actions` and group `ci-workflows` references.
