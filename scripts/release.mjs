#!/usr/bin/env node
// Automated release for this repository.
//
// Closes the gap #15 identified: rule 2 of the contract checker proves a ref
// is immutable, but not that it is *current*. The step-2 release mistake is
// to ship `v1.0.1` while internal refs still say `@v1.0.0` — a tag whose
// own workflows reference the previous release. A static checker cannot
// answer "what is the latest tag?" without leaving hermeticity, and worse,
// the correct answer during the release window itself is "ahead of the
// latest tag", so any such rule would fail every legitimate release.
//
// So the fix is a tool, not a rule:
//
//   1. Read the latest tag from git history.
//   2. Validate the proposed version is a strict semver bump over it.
//   3. Rewrite every `The-Adult-In-The-Room/ci-workflows/...@<semver>` ref
//      under `.github/` to the new tag.
//   4. Commit, tag, push (optional, gated on --push).
//   5. Verify every internal self-ref now equals the tag just cut — the
//      step that closes the gap. If any ref disagrees, the tag is wrong
//      and the tool exits non-zero before the damage reaches consumers.
//
// This script is the single source of truth for both. `npm run release`
// runs it locally; `.github/workflows/_release.yml` runs it in CI. Same
// code path, same guarantees.

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { inc, parse } from 'semver'
import { checkPaths, yamlFilesUnder } from './contract-check.mjs'

// Must match the constant in contract-check.mjs. If you fork this repo,
// update both in lockstep or rule 2 and the release tool silently
// disagree about which refs are "ours".
const SELF_REPO = 'The-Adult-In-The-Room/ci-workflows'

// Any semver tag after `@` — the same shape rule 2 accepts. We only
// rewrite what rule 2 would have allowed, so a stale-but-immutable ref
// gets corrected without disturbing a deliberate SHA pin.
const SELF_REF_PATTERN = new RegExp(
  `(${escapeRegExp(SELF_REPO)}/[^\\s@]+)@(v\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)`,
  'g',
)

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Latest reachable semver tag, via `git describe`. Null if no tags exist. */
export function getLatestTag() {
  try {
    // Only semver release tags (vX.Y.Z...) count as the latest version.
    // The canary system maintains a lightweight `canary` tag that can be
    // the nearest tag on main, and `git describe` would otherwise return
    // it and fail to parse as semver.
    return execSync('git describe --tags --abbrev=0 --match "v*"', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/** Parse a version string with or without the `v` prefix. */
export function parseVersion(version) {
  return parse(version.startsWith('v') ? version.slice(1) : version)
}

/**
 * Compute the next version for a bump keyword. Delegates to `semver.inc`,
 * so `premajor`/`preminor`/`prepatch`/`prerelease` all work and the
 * optional `preid` argument names the prerelease lane (`beta`, `rc`, …).
 */
export function computeBump(current, bump, preid) {
  return inc(current, bump, preid)
}

/**
 * Is `proposed` a legitimate successor to `current`? A release can only
 * move forwards: any accepted `semver.gt` is a valid bump, including
 * prereleases of a not-yet-released minor/patch. The tool does not
 * second-guess *how major* the bump should be — that is a human call,
 * informed by the diff and by consumer impact.
 */
export function validateVersion(proposed, current) {
  const next = parseVersion(proposed)
  if (!next) {
    return { ok: false, error: `\`${proposed}\` is not a valid semver version` }
  }
  if (!current) {
    return { ok: true, value: `v${next.version}`, current: null }
  }
  const prev = parseVersion(current)
  if (!prev) {
    return { ok: false, error: `current tag \`${current}\` is not valid semver` }
  }
  if (next.compare(prev) <= 0) {
    return {
      ok: false,
      error: `\`v${next.version}\` is not greater than the current tag \`v${prev.version}\``,
    }
  }
  return { ok: true, value: `v${next.version}`, current: `v${prev.version}` }
}

/**
 * Rewrite every `SELF_REPO/...@<semver>` ref under `target` (a file, or
 * a directory recursed via `yamlFilesUnder`) to `newTag`. Returns the
 * list of files that actually changed, so the caller can decide whether
 * to commit.
 *
 * SHA pins are left alone: rule 2 accepts them, and a release that moves
 * from one semver tag to another has no opinion about which commit a
 * deliberate SHA pin points at.
 */
export function findAndRewriteSelfRefs(target, newTag) {
  const changed = []
  for (const file of yamlFilesUnder(target)) {
    const original = readFileSync(file, 'utf8')
    const updated = original.replace(SELF_REF_PATTERN, `$1@${newTag}`)
    if (updated !== original) {
      writeFileSync(file, updated)
      changed.push(file)
    }
  }
  return changed
}

/**
 * The post-cut verification that closes #15's gap. Every self-ref under
 * `target` must point at `expectedTag`; anything else — a stale tag, a
 * missed file, a floating ref — is reported. An empty `mismatches` means
 * the tag and the refs agree, which is exactly what consumers depend on.
 */
export function verifySelfRefs(target, expectedTag) {
  const mismatches = []
  const floating = []
  for (const file of yamlFilesUnder(target)) {
    const content = readFileSync(file, 'utf8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.includes(`${SELF_REPO}/`)) continue
      const match = line.match(new RegExp(`${escapeRegExp(SELF_REPO)}/[^\\s@]+@([^\\s"']+)`))
      if (!match) continue
      const ref = match[1]
      if (ref === expectedTag) continue
      if (/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(ref)) {
        mismatches.push({ file, line: i + 1, ref })
      } else {
        floating.push({ file, line: i + 1, ref })
      }
    }
  }
  return { mismatches, floating }
}

function printUsage() {
  console.error(`Usage:
  node scripts/release.mjs <version|bump> [options]

Arguments:
  <version>            Explicit semver version (e.g. v2.3.0, 2.3.0, v2.3.0-beta.1)
  <bump>               Bump keyword: major, minor, patch, premajor, preminor, prepatch, prerelease

Options:
  --preid <id>         Pre-release identifier for pre* bumps (e.g. beta, rc)
  --commit             Stage, commit, and tag — but do not push. Use this when
                       the caller needs to control the push (e.g. a CI workflow
                       that must authenticate with a PAT).
  --push               Commit, tag, AND push (local CLI convenience).
  --target <path>      Directory to rewrite (default: .github)
  --skip-verify        Skip the post-rewrite self-ref verification
`)
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printUsage()
    return argv[0] === '--help' || argv[0] === '-h' ? 0 : 1
  }

  const raw = argv[0]
  const rest = argv.slice(1)
  const flag = (name) => {
    const idx = rest.indexOf(name)
    return idx !== -1 && idx < rest.length - 1 ? rest[idx + 1] : undefined
  }
  const hasFlag = (name) => rest.includes(name)

  const preid = flag('--preid')
  const shouldCommit = hasFlag('--commit') || hasFlag('--push')
  const shouldPush = hasFlag('--push')
  const target = flag('--target') ?? '.github'
  const skipVerify = hasFlag('--skip-verify')

  const latestTag = getLatestTag()
  const currentVersion = latestTag ?? null

  let proposed
  if (/^(major|minor|patch|premajor|preminor|prepatch|prerelease)$/.test(raw)) {
    if (!currentVersion) {
      console.error('release: no existing tag found; pass an explicit version for the first release')
      return 1
    }
    const currentParsed = parseVersion(currentVersion)
    const next = inc(currentParsed, raw, preid)
    if (!next) {
      console.error(`release: could not compute ${raw} bump from ${currentVersion}`)
      return 1
    }
    proposed = `v${next}`
    console.log(`release: ${raw} bump from ${currentVersion} → ${proposed}`)
  } else {
    proposed = raw.startsWith('v') ? raw : `v${raw}`
  }

  const validation = validateVersion(proposed, currentVersion)
  if (!validation.ok) {
    console.error(`release: ${validation.error}`)
    return 1
  }

  const newTag = validation.value
  console.log(`release: ${currentVersion ?? '(none)'} → ${newTag}`)

  const changed = findAndRewriteSelfRefs(target, newTag)
  if (changed.length === 0) {
    console.log('release: no self-references found to rewrite.')
  } else {
    console.log(`release: rewrote ${changed.length} file(s):`)
    for (const file of changed) console.log(`  - ${file}`)
  }

  if (!skipVerify) {
    const { mismatches, floating } = verifySelfRefs(target, newTag)
    if (floating.length > 0) {
      console.error('\nrelease: floating (non-semver) self-refs still present:')
      for (const { file, line, ref } of floating) {
        console.error(`  ${file}:${line}  @${ref}`)
      }
    }
    if (mismatches.length > 0) {
      console.error('\nrelease: verification FAILED — refs disagree with the new tag:')
      for (const { file, line, ref } of mismatches) {
        console.error(`  ${file}:${line}  @${ref}  (expected @${newTag})`)
      }
      return 1
    }
    console.log(`release: verification passed — every self-ref is @${newTag}.`)
  }

  const contractViolations = checkPaths([target])
  if (contractViolations.length > 0) {
    console.error('\nrelease: contract check reported violations after rewrite:')
    for (const v of contractViolations) {
      console.error(`  ${v.file}:${v.line}:${v.column}  [${v.rule}]  ${v.message}`)
    }
    return 1
  }
  console.log('release: contract check passes on the rewritten files.')

  if (!shouldCommit) {
    console.log('\nrelease: files rewritten. Review the diff, then re-run with --commit or --push.')
    return 0
  }

  // --commit or --push: stage, commit, and tag. The commit message carries
  // `[skip ci]` so a push does not re-trigger the Self Check workflow, whose
  // checks the release workflow has already run inline against this exact tree.
  execSync('git add .github/', { stdio: 'inherit' })
  const commitMessage = `chore(release): pin internal cross-references to ${newTag}`
  execSync(`git commit -m ${JSON.stringify(commitMessage)} -m "[skip ci]"`, { stdio: 'inherit' })
  execSync(`git tag -a ${newTag} -m ${JSON.stringify(`Release ${newTag}`)}`, { stdio: 'inherit' })

  if (!shouldPush) {
    // --commit: the caller controls the push. This is what the release
    // workflow uses — it reconfigures the remote with a PAT that has the
    // `workflows` permission before pushing, because GITHUB_TOKEN cannot
    // modify workflow files.
    console.log(`\nrelease: ${newTag} committed and tagged. Push is the caller's responsibility.`)
    return 0
  }

  // --push: local CLI convenience. Push with whatever remote URL is already
  // configured. This works for local development where the user's git
  // credentials have the necessary permissions.
  let branch
  try {
    branch = execSync('git symbolic-ref --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim()
  }
  execSync(`git push origin ${branch} ${newTag}`, { stdio: 'inherit' })

  console.log(`\nrelease: ${newTag} committed, tagged, and pushed.`)
  return 0
}

const isMain =
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], 'file:').href

if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error)
      process.exit(1)
    },
  )
}
