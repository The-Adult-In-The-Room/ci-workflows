#!/usr/bin/env node
// Unit tests for scripts/canary-scope.mjs

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeTargets } from './canary-scope.mjs'

// Sample rules matching .github/_canary-map.yml
const SAMPLE_RULES = [
  {
    targets: ['verify'],
    paths: ['.github/workflows/verify.yml'],
  },
  {
    targets: ['lighthouse'],
    paths: ['.github/workflows/lighthouse.yml'],
  },
  {
    targets: ['deploy'],
    paths: [
      '.github/workflows/deploy-and-smoke.yml',
      '.github/workflows/smoke.yml',
    ],
  },
  {
    targets: ['verify', 'deploy'],
    paths: [
      '.github/actions/playwright-test/**',
      '.github/actions/setup-node/**',
    ],
  },
]

describe('computeTargets', () => {
  describe('basic matching', () => {
    it('returns verify target when verify.yml changes', () => {
      const paths = ['.github/workflows/verify.yml']
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, ['verify'])
    })

    it('returns deploy target when deploy-and-smoke.yml changes', () => {
      const paths = ['.github/workflows/deploy-and-smoke.yml']
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, ['deploy'])
    })

    it('returns lighthouse target when lighthouse.yml changes', () => {
      const paths = ['.github/workflows/lighthouse.yml']
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, ['lighthouse'])
    })

    it('returns both targets when a composite action changes', () => {
      const paths = ['.github/actions/playwright-test/action.yml']
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, ['deploy', 'verify'])
    })

    it('returns union of targets when multiple files change', () => {
      const paths = [
        '.github/workflows/verify.yml',
        '.github/workflows/deploy-and-smoke.yml',
      ]
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, ['deploy', 'verify'])
    })

    it('returns union of all three targets when verify, lighthouse, and deploy change', () => {
      const paths = [
        '.github/workflows/verify.yml',
        '.github/workflows/lighthouse.yml',
        '.github/workflows/deploy-and-smoke.yml',
      ]
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, ['deploy', 'lighthouse', 'verify'])
    })

    it('deduplicates targets', () => {
      const paths = [
        '.github/actions/playwright-test/action.yml',
        '.github/actions/setup-node/action.yml',
      ]
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, ['deploy', 'verify'])
    })
  })

  describe('fail-safe: map file changed', () => {
    it('returns ALL targets when _canary-map.yml is in the diff', () => {
      const paths = ['.github/_canary-map.yml']
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, ['deploy', 'lighthouse', 'verify'])
    })

    it('returns ALL targets even if other files also changed', () => {
      const paths = [
        '.github/_canary-map.yml',
        '.github/workflows/verify.yml',
      ]
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, ['deploy', 'lighthouse', 'verify'])
    })
  })

  describe('fail-safe: unmatched path', () => {
    it('returns ALL targets when a path does not match any rule', () => {
      const paths = ['.github/workflows/unknown.yml']
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, ['deploy', 'lighthouse', 'verify'])
    })

    it('returns ALL targets when mixing matched and unmatched paths', () => {
      const paths = [
        '.github/workflows/verify.yml',
        'README.md',
      ]
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, ['deploy', 'lighthouse', 'verify'])
    })

    it('returns ALL targets for root-level file changes', () => {
      const paths = ['package.json']
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, ['deploy', 'lighthouse', 'verify'])
    })
  })

  describe('empty input', () => {
    it('returns empty array when no paths are provided', () => {
      const paths = []
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, [])
    })
  })

  describe('glob pattern matching', () => {
    it('matches nested files with ** pattern', () => {
      const paths = ['.github/actions/playwright-test/subdir/action.yml']
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, ['deploy', 'verify'])
    })

    it('matches files at any depth with ** pattern', () => {
      const paths = ['.github/actions/setup-node/deep/nested/file.txt']
      const targets = computeTargets(paths, SAMPLE_RULES)
      assert.deepStrictEqual(targets, ['deploy', 'verify'])
    })
  })

  describe('invalid rules', () => {
    it('throws when a rule is missing targets array', () => {
      const invalidRules = [{ paths: ['.github/workflows/verify.yml'] }]
      const paths = ['.github/workflows/verify.yml']
      assert.throws(() => {
        computeTargets(paths, invalidRules)
      }, /Invalid rule/)
    })

    it('throws when a rule is missing paths array', () => {
      const invalidRules = [{ targets: ['verify'] }]
      const paths = ['.github/workflows/verify.yml']
      assert.throws(() => {
        computeTargets(paths, invalidRules)
      }, /Invalid rule/)
    })
  })
})
