import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, beforeEach } from 'node:test'
import { tmpdir } from 'node:os'

import {
  parseVersion,
  computeBump,
  validateVersion,
  findAndRewriteSelfRefs,
  verifySelfRefs,
  getLatestTag,
} from './release.ts'

// ---------- parseVersion ----------

describe('parseVersion', () => {
  it('accepts a bare semver triple', () => {
    const parsed = parseVersion('1.2.3')
    assert.ok(parsed)
    assert.equal(parsed.version, '1.2.3')
  })

  it('strips a leading `v`', () => {
    const parsed = parseVersion('v1.2.3')
    assert.ok(parsed)
    assert.equal(parsed.version, '1.2.3')
  })

  it('preserves a pre-release suffix', () => {
    const parsed = parseVersion('v1.2.3-beta.1')
    assert.ok(parsed)
    assert.deepEqual(parsed.prerelease, ['beta', 1])
  })

  it('returns null for garbage', () => {
    assert.equal(parseVersion('not-a-version'), null)
    assert.equal(parseVersion('v1'), null)
    assert.equal(parseVersion(''), null)
  })
})

// ---------- computeBump ----------

describe('computeBump', () => {
  it('bumps patch', () => {
    assert.equal(computeBump('1.2.3', 'patch'), '1.2.4')
  })

  it('bumps minor and resets patch', () => {
    assert.equal(computeBump('1.2.3', 'minor'), '1.3.0')
  })

  it('bumps major and resets minor+patch', () => {
    assert.equal(computeBump('1.2.3', 'major'), '2.0.0')
  })

  it('bumps to a named pre-release lane', () => {
    assert.equal(computeBump('1.2.3', 'preminor', 'beta'), '1.3.0-beta.0')
  })

  it('advances an existing pre-release within the same lane', () => {
    assert.equal(computeBump('1.3.0-beta.0', 'prerelease', 'beta'), '1.3.0-beta.1')
  })
})

// ---------- validateVersion ----------

describe('validateVersion', () => {
  it('accepts a patch bump', () => {
    const result = validateVersion('v1.0.1', 'v1.0.0')
    assert.equal(result.ok, true)
    assert.equal(result.value, 'v1.0.1')
    assert.equal(result.current, 'v1.0.0')
  })

  it('accepts a minor bump', () => {
    const result = validateVersion('v1.1.0', 'v1.0.0')
    assert.equal(result.ok, true)
    assert.equal(result.value, 'v1.1.0')
  })

  it('accepts a major bump', () => {
    const result = validateVersion('v2.0.0', 'v1.9.9')
    assert.equal(result.ok, true)
    assert.equal(result.value, 'v2.0.0')
  })

  it('accepts a pre-release of the next patch', () => {
    // v1.0.1-beta.1 > v1.0.0 in semver, so this is a legitimate bump.
    const result = validateVersion('v1.0.1-beta.1', 'v1.0.0')
    assert.equal(result.ok, true)
  })

  it('rejects the same version as the current tag', () => {
    const result = validateVersion('v1.0.0', 'v1.0.0')
    assert.equal(result.ok, false)
    assert.match(result.error, /not greater than/)
  })

  it('rejects a lower version', () => {
    const result = validateVersion('v1.0.0', 'v2.0.0')
    assert.equal(result.ok, false)
    assert.match(result.error, /not greater than/)
  })

  it('rejects a non-semver proposed version', () => {
    const result = validateVersion('not-a-version', 'v1.0.0')
    assert.equal(result.ok, false)
    assert.match(result.error, /not a valid semver/)
  })

  it('allows any proposed version when no current tag exists', () => {
    const result = validateVersion('v0.1.0', null)
    assert.equal(result.ok, true)
    assert.equal(result.current, null)
  })

  it('tolerates a bare version without the `v` prefix', () => {
    const result = validateVersion('1.0.1', 'v1.0.0')
    assert.equal(result.ok, true)
    assert.equal(result.value, 'v1.0.1')
  })
})

// ---------- findAndRewriteSelfRefs ----------

describe('findAndRewriteSelfRefs', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ci-workflows-release-'))
    mkdirSync(join(tmpDir, '.github', 'workflows'), { recursive: true })
    mkdirSync(join(tmpDir, '.github', 'actions', 'example'), { recursive: true })
  })

  const writeWorkflow = (name: string, content: string): string => {
    const path = join(tmpDir, '.github', 'workflows', name)
    writeFileSync(path, content)
    return path
  }

  const writeAction = (name: string, content: string): string => {
    const path = join(tmpDir, '.github', 'actions', name, 'action.yml')
    writeFileSync(path, content)
    return path
  }

  it('rewrites a stale semver tag in a workflow', () => {
    const path = writeWorkflow(
      'verify.yml',
      `jobs:
  test:
    steps:
      - uses: The-Adult-In-The-Room/ci-workflows/.github/actions/setup-node@v1.0.0
`,
    )
    const changed = findAndRewriteSelfRefs(join(tmpDir, '.github'), 'v2.0.0')
    assert.deepEqual(changed, [path])
    const content = readFileSync(path, 'utf8')
    assert.match(content, /setup-node@v2\.0\.0/)
    assert.doesNotMatch(content, /setup-node@v1\.0\.0/)
  })

  it('rewrites multiple refs across multiple files in one pass', () => {
    const wf = writeWorkflow(
      'verify.yml',
      `steps:
  - uses: The-Adult-In-The-Room/ci-workflows/.github/actions/setup-node@v1.0.0
  - uses: The-Adult-In-The-Room/ci-workflows/.github/actions/playwright-test@v1.0.0
`,
    )
    const action = writeAction(
      'example',
      `runs:
  steps:
    - uses: The-Adult-In-The-Room/ci-workflows/.github/actions/setup-node@v1.0.0
`,
    )
    const changed = findAndRewriteSelfRefs(join(tmpDir, '.github'), 'v2.0.0').sort()
    assert.deepEqual(changed, [action, wf].sort())
  })

  it('leaves SHA pins alone — the release tool has no opinion about them', () => {
    const path = writeWorkflow(
      'pinned.yml',
      `steps:
  - uses: The-Adult-In-The-Room/ci-workflows/.github/actions/setup-node@0123456789abcdef0123456789abcdef01234567
`,
    )
    const changed = findAndRewriteSelfRefs(join(tmpDir, '.github'), 'v2.0.0')
    assert.deepEqual(changed, [])
    assert.match(
      readFileSync(path, 'utf8'),
      /setup-node@0123456789abcdef0123456789abcdef01234567/,
    )
  })

  it('leaves third-party actions alone', () => {
    const path = writeWorkflow(
      'third-party.yml',
      `steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
`,
    )
    const changed = findAndRewriteSelfRefs(join(tmpDir, '.github'), 'v2.0.0')
    assert.deepEqual(changed, [])
  })

  it('returns an empty list when every ref already matches', () => {
    const path = writeWorkflow(
      'current.yml',
      `steps:
  - uses: The-Adult-In-The-Room/ci-workflows/.github/actions/setup-node@v2.0.0
`,
    )
    const changed = findAndRewriteSelfRefs(join(tmpDir, '.github'), 'v2.0.0')
    assert.deepEqual(changed, [])
    // File was not rewritten — its content is unchanged.
    assert.match(readFileSync(path, 'utf8'), /setup-node@v2\.0\.0/)
  })

  it('rewrites a pre-release ref to a release ref', () => {
    const path = writeWorkflow(
      'prerelease.yml',
      `steps:
  - uses: The-Adult-In-The-Room/ci-workflows/.github/actions/setup-node@v2.0.0-beta.1
`,
    )
    const changed = findAndRewriteSelfRefs(join(tmpDir, '.github'), 'v2.0.0')
    assert.deepEqual(changed, [path])
    assert.match(readFileSync(path, 'utf8'), /setup-node@v2\.0\.0\n/)
  })
})

// ---------- verifySelfRefs ----------

describe('verifySelfRefs', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ci-workflows-verify-'))
    mkdirSync(join(tmpDir, '.github', 'workflows'), { recursive: true })
  })

  const writeWorkflow = (name: string, content: string): string => {
    const path = join(tmpDir, '.github', 'workflows', name)
    writeFileSync(path, content)
    return path
  }

  it('passes when every ref matches the expected tag', () => {
    writeWorkflow(
      'verify.yml',
      `steps:
  - uses: The-Adult-In-The-Room/ci-workflows/.github/actions/setup-node@v2.0.0
  - uses: The-Adult-In-The-Room/ci-workflows/.github/actions/playwright-test@v2.0.0
`,
    )
    const result = verifySelfRefs(join(tmpDir, '.github'), 'v2.0.0')
    assert.deepEqual(result.mismatches, [])
    assert.deepEqual(result.floating, [])
  })

  it('reports a stale-but-immutable ref as a mismatch', () => {
    const path = writeWorkflow(
      'verify.yml',
      `steps:
  - uses: The-Adult-In-The-Room/ci-workflows/.github/actions/setup-node@v1.0.0
`,
    )
    const result = verifySelfRefs(join(tmpDir, '.github'), 'v2.0.0')
    assert.equal(result.mismatches.length, 1)
    assert.equal(result.mismatches[0].ref, 'v1.0.0')
    assert.equal(result.mismatches[0].file, path)
    assert.equal(result.mismatches[0].line, 2)
  })

  it('reports a floating ref separately from a stale one', () => {
    writeWorkflow(
      'verify.yml',
      `steps:
  - uses: The-Adult-In-The-Room/ci-workflows/.github/actions/setup-node@main
  - uses: The-Adult-In-The-Room/ci-workflows/.github/actions/playwright-test@v1.0.0
`,
    )
    const result = verifySelfRefs(join(tmpDir, '.github'), 'v2.0.0')
    assert.equal(result.floating.length, 1)
    assert.equal(result.floating[0].ref, 'main')
    assert.equal(result.mismatches.length, 1)
    assert.equal(result.mismatches[0].ref, 'v1.0.0')
  })

  it('reports nothing when there are no self-refs at all', () => {
    writeWorkflow(
      'external.yml',
      `steps:
  - uses: actions/checkout@v4
`,
    )
    const result = verifySelfRefs(join(tmpDir, '.github'), 'v2.0.0')
    assert.deepEqual(result.mismatches, [])
    assert.deepEqual(result.floating, [])
  })
})

// ---------- getLatestTag ----------
//
// These tests spin up a throwaway git repo so `git describe` has a real
// history to read from. They assert the integration between the tool and
// git, not the shape of `git describe`'s output.

describe('getLatestTag (with real git)', () => {
  let tmpDir: string
  let originalCwd: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ci-workflows-git-'))
    originalCwd = process.cwd()
    process.chdir(tmpDir)
    execSync('git init -q -b main')
    execSync('git config user.email "test@example.com"')
    execSync('git config user.name "Test"')
  })

  it('returns null when no tags exist', () => {
    writeFileSync('README.md', 'hello')
    execSync('git add . && git commit -q -m "init"')
    assert.equal(getLatestTag(), null)
  })

  it('returns the most recent reachable tag', () => {
    writeFileSync('a', '1')
    execSync('git add . && git commit -q -m "first"')
    execSync('git tag v1.0.0')
    writeFileSync('b', '2')
    execSync('git add . && git commit -q -m "second"')
    execSync('git tag v1.0.1')
    assert.equal(getLatestTag(), 'v1.0.1')
  })

  it('ignores non-semver tags such as canary', () => {
    writeFileSync('a', '1')
    execSync('git add . && git commit -q -m "first"')
    execSync('git tag v1.0.0')
    writeFileSync('b', '2')
    execSync('git add . && git commit -q -m "second"')
    execSync('git tag canary')
    assert.equal(getLatestTag(), 'v1.0.0')
  })

  it('ignores an unreachable tag on another branch', () => {
    writeFileSync('a', '1')
    execSync('git add . && git commit -q -m "first"')
    execSync('git tag v1.0.0')

    execSync('git checkout -q -b other')
    writeFileSync('b', '2')
    execSync('git add . && git commit -q -m "other"')
    execSync('git tag v9.9.9')

    execSync('git checkout -q main')
    assert.equal(getLatestTag(), 'v1.0.0')
  })

  it('after all tests: restore cwd', () => {
    // `after` would be cleaner, but `node:test`'s `beforeEach` runs before
    // every `it`, so we restore cwd here as a final safety net. The other
    // `it` blocks above each rely on the cwd being `tmpDir`, which
    // `beforeEach` guarantees. This block just resets for whatever runs
    // after the describe.
    process.chdir(originalCwd)
  })
})
