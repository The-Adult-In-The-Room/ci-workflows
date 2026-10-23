#!/usr/bin/env node
// Determine which canary targets to run based on changed files in a diff.
// Reads a list of changed paths (from git diff) and the _canary-map.yml,
// then emits the union of targets that match the changed paths.
//
// Fail-safe rules:
//   - If _canary-map.yml itself is in the diff, run ALL targets
//   - If a changed path doesn't match any rule, run ALL targets
//   - If no paths match any rule, emit an empty array (no targets to run)
//
// Usage:
//   node scripts/canary-scope.ts <path1> <path2> ...
//
// Or with git diff:
//   node scripts/canary-scope.ts $(git diff --name-only origin/main...HEAD)
//
// Output:
//   JSON array of target names, e.g. ["verify", "deploy"]

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { minimatch } from 'minimatch'

// All known targets. If we add a new target, add it here.
// Sorted alphabetically for consistent output.
const ALL_TARGETS: readonly string[] = ['deploy', 'lighthouse', 'verify']

// The map file itself triggers all targets when changed (fail-safe).
const MAP_FILE = '.github/_canary-map.yml'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CanaryRule {
  targets: string[]
  paths: string[]
}

// ---------------------------------------------------------------------------
// Map loading
// ---------------------------------------------------------------------------

/**
 * Load and parse the _canary-map.yml file.
 * Returns the rules array, or throws if the file is missing or malformed.
 */
function loadCanaryMap(repoRoot: string): CanaryRule[] {
  const mapPath = join(repoRoot, MAP_FILE)
  const content = readFileSync(mapPath, 'utf8')
  const doc = parse(content) as { rules?: unknown }
  const rules = doc.rules
  if (!Array.isArray(rules)) {
    throw new Error(`_canary-map.yml must contain a 'rules' array`)
  }
  return rules.map((rule) => {
    if (!isCanaryRule(rule)) {
      throw new Error(`Invalid rule: must have 'targets' and 'paths' arrays`)
    }
    return rule
  })
}

function isCanaryRule(value: unknown): value is CanaryRule {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return Array.isArray(candidate.targets) && Array.isArray(candidate.paths)
}

/**
 * Check if a path matches any of the glob patterns in a rule.
 * Supports ** for recursive directory matching.
 */
function pathMatchesPatterns(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true }))
}

// ---------------------------------------------------------------------------
// Target computation
// ---------------------------------------------------------------------------

/**
 * Given a list of changed paths and the canary map rules,
 * return the set of targets to run.
 *
 * Returns:
 *   - An array of target names (e.g. ['verify', 'deploy'])
 *   - An empty array if no targets should run (no matches)
 *
 * Fail-safe: if the map file itself is changed, or if any path
 * doesn't match any rule, returns ALL_TARGETS.
 */
export function computeTargets(changedPaths: string[], rules: CanaryRule[]): string[] {
  // Fail-safe 1: if the map itself changed, run all targets
  if (changedPaths.includes(MAP_FILE)) {
    return [...ALL_TARGETS]
  }

  const targets = new Set<string>()
  let hasUnmatched = false

  for (const path of changedPaths) {
    let matched = false
    for (const rule of rules) {
      if (!Array.isArray(rule.targets) || !Array.isArray(rule.paths)) {
        throw new Error(`Invalid rule: must have 'targets' and 'paths' arrays`)
      }
      if (pathMatchesPatterns(path, rule.paths)) {
        matched = true
        rule.targets.forEach((t) => targets.add(t))
      }
    }
    // Fail-safe 2: if this path doesn't match any rule, run all targets
    if (!matched) {
      hasUnmatched = true
    }
  }

  if (hasUnmatched) {
    return [...ALL_TARGETS]
  }

  return Array.from(targets).sort()
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const changedPaths = process.argv.slice(2)

  if (changedPaths.length === 0) {
    // No changes = no targets to run
    console.log(JSON.stringify([]))
    return
  }

  const repoRoot = process.cwd()
  const rules = loadCanaryMap(repoRoot)
  const targets = computeTargets(changedPaths, rules)

  console.log(JSON.stringify(targets))
}

// Run main if this is the entry point (not imported as a module)
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
