import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  actionlintVersionFromOutput,
  pinnedActionlintVersion,
  shellcheckVersionFromOutput,
  tripleForPlatform,
} from './lint-workflows.ts'

// ---------- pinnedActionlintVersion ----------

describe('pinnedActionlintVersion', () => {
  it('reads the pinned version from the real _self-check.yml', () => {
    const result = pinnedActionlintVersion(
      readFileSync('.github/workflows/_self-check.yml', 'utf8'),
    )
    assert.ok(result.ok)
    assert.match(result.version, /^\d+\.\d+\.\d+$/)
  })

  it('finds the actionlint step among other steps', () => {
    const yaml = `
jobs:
  lint:
    steps:
      - uses: actions/checkout@v7
      - run: echo hello
      - uses: rhysd/actionlint@v1.7.12
`
    const result = pinnedActionlintVersion(yaml)
    assert.deepEqual(result, { ok: true, version: '1.7.12' })
  })

  it('fails when jobs.lint.steps is missing', () => {
    const result = pinnedActionlintVersion('jobs:\n  other:\n    steps: []\n')
    assert.ok(!result.ok)
    assert.match(result.error, /jobs\.lint\.steps/)
  })

  it('ignores a floating actionlint ref', () => {
    // Only an exact vX.Y.Z pin is a version we can mirror; a floating
    // ref is exactly the bug this script exists to prevent.
    const yaml = `
jobs:
  lint:
    steps:
      - uses: rhysd/actionlint@v1
`
    const result = pinnedActionlintVersion(yaml)
    assert.ok(!result.ok)
    assert.match(result.error, /rhysd\/actionlint/)
  })

  it('fails when no actionlint step exists', () => {
    const yaml = `
jobs:
  lint:
    steps:
      - uses: actions/checkout@v7
`
    const result = pinnedActionlintVersion(yaml)
    assert.ok(!result.ok)
    assert.match(result.error, /rhysd\/actionlint/)
  })
})

// ---------- actionlintVersionFromOutput ----------

describe('actionlintVersionFromOutput', () => {
  it('parses a bare version on the first line', () => {
    assert.equal(actionlintVersionFromOutput('1.7.12\n'), '1.7.12')
  })

  it('ignores output after the first line', () => {
    assert.equal(
      actionlintVersionFromOutput('1.7.12\nbuilt with go1.23\n'),
      '1.7.12',
    )
  })

  it('returns null for garbage', () => {
    assert.equal(actionlintVersionFromOutput('not-a-version\n'), null)
    assert.equal(actionlintVersionFromOutput(''), null)
  })
})

// ---------- shellcheckVersionFromOutput ----------

describe('shellcheckVersionFromOutput', () => {
  it('parses the version line from --version output', () => {
    const output = `ShellCheck - shell script analysis tool
version: 0.10.0
license: GNU General Public License, version 3
website: https://www.shellcheck.net
`
    assert.equal(shellcheckVersionFromOutput(output), '0.10.0')
  })

  it('returns null when no version line exists', () => {
    assert.equal(shellcheckVersionFromOutput('ShellCheck\n'), null)
  })
})

// ---------- tripleForPlatform ----------

describe('tripleForPlatform', () => {
  it('looks up a supported platform/arch pair', () => {
    assert.equal(
      tripleForPlatform({ 'linux x64': 'linux_amd64' }, 'linux', 'x64'),
      'linux_amd64',
    )
  })

  it('returns null for an unsupported pair', () => {
    assert.equal(
      tripleForPlatform({ 'linux x64': 'linux_amd64' }, 'freebsd', 'x64'),
      null,
    )
  })
})
