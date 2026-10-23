import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { analyzeSource, checkPaths, checkCanaryMapCoverage } from './contract-check.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

const rulesFor = (fixture: string) => {
  const source = readFileSync(join(FIXTURES, fixture), 'utf8')
  return analyzeSource(source, { file: fixture })
}

/**
 * Every fixture other than `allowed.yml` is named for the rule it exists to
 * prove. Asserting on the exact rule set — not merely "something failed" — is
 * what stops a rule from silently widening into its neighbours.
 */
const EXPECTED: Record<string, string[]> = {
  'bug-1-relative-uses.yml': ['no-relative-uses-in-composite-action'],
  'bug-2-double-npm-run.yml': ['no-inputs-in-run-body', 'script-name-discipline'],
  'bug-3-undocumented-secret.yml': ['required-secrets-documented'],
  'bug-4-floating-ref.yml': ['no-branch-refs-for-self-references'],
  'bug-5-colon-artifact-name.yml': ['artifact-name-safety'],
  'bug-6-input-in-run-body.yml': ['no-inputs-in-run-body'],
  'r3-missing-type.yml': ['input-completeness', 'no-inputs-in-run-body'],
  'r3-omittable-input.yml': ['input-completeness'],
  'r3-undeclared-input.yml': ['input-completeness', 'no-inputs-in-run-body'],
}

const fixtureNames = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.yml'))
  .sort()

describe('contract fixtures', () => {
  it('covers every fixture file with an expectation', () => {
    // Guards against a new fixture being added without a matching assertion.
    assert.deepEqual(
      fixtureNames.filter((name) => name !== 'allowed.yml'),
      Object.keys(EXPECTED).sort(),
    )
  })

  for (const [fixture, expected] of Object.entries(EXPECTED)) {
    it(`${fixture} reports exactly ${expected.join(', ')}`, () => {
      const violations = rulesFor(fixture)
      assert.deepEqual(
        violations.map((violation) => violation.rule).sort(),
        [...expected].sort(),
      )
      for (const violation of violations) {
        assert.ok(violation.line > 0, 'violation must carry a line number')
        assert.ok(violation.message.length > 0, 'violation must explain itself')
      }
    })
  }
})

describe('no false positives', () => {
  it('allowed.yml satisfies every rule', () => {
    assert.deepEqual(rulesFor('allowed.yml'), [])
  })

  // #3's acceptance criterion: the rules pass on current main. If this fails,
  // either a rule is wrong or the workflows are — both worth knowing before a
  // ruleset depends on this check.
  it('the real workflows and actions satisfy every rule', () => {
    const violations = checkPaths([join(REPO_ROOT, '.github')])
    assert.deepEqual(
      violations.map((violation) => `${violation.file}: ${violation.message}`),
      [],
    )
  })
})

describe('input resolution', () => {
  const workflowWith = (inputs: string, step: string): string =>
    `on:\n  workflow_call:\n    inputs:\n${inputs}\njobs:\n  j:\n    steps:\n      - run: ${step}\n`

  it('reports unparseable YAML instead of passing vacuously', () => {
    const violations = analyzeSource('on:\n  workflow_call:\n   - [oops\n')
    assert.ok(violations.length > 0)
    assert.equal(violations[0].rule, 'parse-error')
  })

  it('reads `on:` as a key, not a YAML 1.1 boolean', () => {
    // If a future dependency bump restores YAML 1.1 semantics, workflow_call
    // inputs would silently stop being found and rule 3 would pass vacuously.
    const violations = analyzeSource(
      'on:\n  workflow_call:\n    inputs:\n      a:\n        description: no type\n',
    )
    assert.deepEqual(
      violations.map((violation) => violation.rule),
      ['input-completeness'],
    )
  })

  it('sees an input nested inside a function call', () => {
    // `${{ fromJson(inputs.days) }}` is a real shape in playwright-test. A
    // reference extractor that only matches `${{ inputs.x }}` misses it, and
    // `fromJson('')` fails at runtime with a confusing message.
    const violations = analyzeSource(
      workflowWith('      days:\n        type: string\n', 'echo ${{ fromJson(inputs.days) }}'),
    )
    assert.deepEqual(
      violations.map((violation) => violation.rule).sort(),
      ['input-completeness', 'no-inputs-in-run-body'].sort(),
    )
  })

  it('does not mistake github.event.inputs for a declared input', () => {
    const violations = analyzeSource(
      workflowWith('      name:\n        type: string\n', 'echo ${{ github.event.inputs.name }}'),
    )
    assert.deepEqual(violations, [])
  })

  it('catches a script-name default behind a fallback expression', () => {
    const violations = analyzeSource(
      workflowWith(
        '      cmd:\n        type: string\n        default: npm run build\n',
        "npm run ${{ inputs.cmd || 'test' }}",
      ),
    )
    assert.deepEqual(
      violations.map((violation) => violation.rule).sort(),
      ['no-inputs-in-run-body', 'script-name-discipline'].sort(),
    )
  })
})

describe('artifact names', () => {
  const artifactWorkflow = (uses: string, name: string): string =>
    `on:\n  workflow_call:\n    inputs:\n      command:\n        type: string\n        default: test:e2e:smoke\njobs:\n  j:\n    steps:\n      - uses: ${uses}\n        with:\n          name: ${name}\n`

  // The constraint belongs to the action, not the ref, so the rule must not
  // depend on which tag a consumer happens to be pinned to.
  it('flags an input in an artifact name, whatever the ref', () => {
    for (const uses of [
      'actions/upload-artifact@v7',
      'actions/upload-artifact@v4',
      'actions/download-artifact@v7',
    ]) {
      const violations = analyzeSource(artifactWorkflow(uses, 'report-${{ inputs.command }}'))
      assert.deepEqual(
        violations.map((violation) => violation.rule),
        ['artifact-name-safety'],
        uses,
      )
    }
  })

  it('allows a name derived from a step output', () => {
    // Rule 6's own fix: sanitise in a step, forward the output. If this ever
    // fails, the rule has started rejecting the shape it exists to recommend.
    const violations = analyzeSource(
      artifactWorkflow('actions/upload-artifact@v7', '${{ steps.artifact.outputs.name }}'),
    )
    assert.deepEqual(violations, [])
  })

  it('ignores the name input of an action that is not an artifact action', () => {
    // Many actions take an innocuous `name`. Keying off the key rather than the
    // action would flag all of them.
    const violations = analyzeSource(
      artifactWorkflow('actions/cache@v4', 'npm-${{ inputs.command }}'),
    )
    assert.deepEqual(violations, [])
  })
})

describe('canary map coverage', () => {
  const tempDir = join(REPO_ROOT, 'test-canary-coverage-temp')

  const setup = (
    workflows: Record<string, string>,
    actions: Record<string, string>,
    mapContent: string | null,
  ): (() => void) => {
    // Clean up any existing test directory
    rmSync(tempDir, { recursive: true, force: true })

    // Create directory structure
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true })
    mkdirSync(join(tempDir, '.github', 'actions'), { recursive: true })

    // Write workflows
    for (const [name, content] of Object.entries(workflows)) {
      writeFileSync(join(tempDir, '.github', 'workflows', name), content)
    }

    // Write actions
    for (const [name, content] of Object.entries(actions)) {
      mkdirSync(join(tempDir, '.github', 'actions', name), { recursive: true })
      writeFileSync(join(tempDir, '.github', 'actions', name, 'action.yml'), content)
    }

    // Write canary map
    if (mapContent) {
      writeFileSync(join(tempDir, '.github', '_canary-map.yml'), mapContent)
    }

    // Change to temp directory for the check
    const originalCwd = process.cwd()
    process.chdir(tempDir)

    return () => {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
    }
  }

  it('reports violation when consumer-facing workflow is not in map', () => {
    const cleanup = setup(
      {
        'verify.yml': 'on: workflow_call\njobs: {}',
        'missing.yml': 'on: workflow_call\njobs: {}',
      },
      {},
      `rules:
  - targets: [verify]
    paths:
      - .github/workflows/verify.yml
`,
    )

    try {
      const violations = checkCanaryMapCoverage()
      assert.equal(violations.length, 1)
      assert.equal(violations[0].rule, 'canary-map-coverage')
      assert.match(violations[0].message, /missing\.yml/)
    } finally {
      cleanup()
    }
  })

  it('passes when all consumer-facing workflows are in map', () => {
    const cleanup = setup(
      {
        'verify.yml': 'on: workflow_call\njobs: {}',
        'deploy.yml': 'on: workflow_call\njobs: {}',
      },
      {},
      `rules:
  - targets: [verify]
    paths:
      - .github/workflows/verify.yml
  - targets: [deploy]
    paths:
      - .github/workflows/deploy.yml
`,
    )

    try {
      const violations = checkCanaryMapCoverage()
      assert.equal(violations.length, 0)
    } finally {
      cleanup()
    }
  })

  it('ignores internal workflows (prefixed with _)', () => {
    const cleanup = setup(
      {
        'verify.yml': 'on: workflow_call\njobs: {}',
        '_internal.yml': 'on: workflow_call\njobs: {}',
      },
      {},
      `rules:
  - targets: [verify]
    paths:
      - .github/workflows/verify.yml
`,
    )

    try {
      const violations = checkCanaryMapCoverage()
      assert.equal(violations.length, 0)
    } finally {
      cleanup()
    }
  })

  it('reports violation when composite action is not in map', () => {
    const cleanup = setup(
      {
        'verify.yml': 'on: workflow_call\njobs: {}',
      },
      {
        'test-action': 'name: Test Action\nruns: { using: composite, steps: [] }',
      },
      `rules:
  - targets: [verify]
    paths:
      - .github/workflows/verify.yml
`,
    )

    try {
      const violations = checkCanaryMapCoverage()
      assert.equal(violations.length, 1)
      assert.equal(violations[0].rule, 'canary-map-coverage')
      assert.match(violations[0].message, /test-action/)
    } finally {
      cleanup()
    }
  })

  it('passes when composite action is in map', () => {
    const cleanup = setup(
      {
        'verify.yml': 'on: workflow_call\njobs: {}',
      },
      {
        'test-action': 'name: Test Action\nruns: { using: composite, steps: [] }',
      },
      `rules:
  - targets: [verify]
    paths:
      - .github/workflows/verify.yml
      - .github/actions/test-action/**
`,
    )

    try {
      const violations = checkCanaryMapCoverage()
      assert.equal(violations.length, 0)
    } finally {
      cleanup()
    }
  })

  it('handles missing canary map gracefully', () => {
    const cleanup = setup(
      {
        'verify.yml': 'on: workflow_call\njobs: {}',
      },
      {},
      null, // No map file
    )

    try {
      const violations = checkCanaryMapCoverage()
      assert.equal(violations.length, 0)
    } finally {
      cleanup()
    }
  })
})
