#!/usr/bin/env node
// Canary test helper: manually move the `canary` tag and trigger blog canary.
// Use this for ad-hoc testing when you don't want to open a PR.
//
// Usage:
//   node scripts/canary-test.mjs              # Test current HEAD
//   node scripts/canary-test.mjs <sha|ref>    # Test specific commit
//
// This script:
//   1. Deletes the existing `canary` tag (locally and remotely)
//   2. Creates a new `canary` tag on the specified commit
//   3. Pushes the tag
//   4. Dispatches to blog canary (triggers the workflow)

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { computeTargets } from './canary-scope.mjs'

const REPO_OWNER = 'The-Adult-In-The-Room'
const BLOG_REPO = 'blog'

function run(cmd) {
  try {
    execSync(cmd, { stdio: 'inherit' })
  } catch (error) {
    console.error(`Command failed: ${cmd}`)
    process.exit(1)
  }
}

function getGitToken() {
  // Try environment variable first
  if (process.env.CANARY_PAT) {
    return process.env.CANARY_PAT
  }
  
  // Try to get token from git remote URL
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf8' }).trim()
    const match = remote.match(/https:\/\/([^:]+):([^@]+)@github\.com/)
    if (match) {
      return match[2]
    }
  } catch {
    // No token in remote URL
  }
  
  console.error('Error: No git token found.')
  console.error('Set CANARY_PAT environment variable or configure git remote with token.')
  process.exit(1)
}

async function dispatchToBlog(token, targets) {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${BLOG_REPO}/dispatches`
  const payload = JSON.stringify({
    event_type: 'canary',
    client_payload: {
      pr: 0, // Manual test, no PR
      targets: JSON.stringify(targets)
    }
  })
  
  console.log('\nDispatching to blog canary...')
  console.log(`Targets: ${JSON.stringify(targets)}`)
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: payload
    })
    
    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Dispatch failed: ${response.status} ${error}`)
    }
    
    console.log('✓ Dispatch successful')
    console.log(`\nCheck blog Actions: https://github.com/${REPO_OWNER}/${BLOG_REPO}/actions`)
  } catch (error) {
    console.error(`Error: ${error.message}`)
    process.exit(1)
  }
}

async function main() {
  const target = process.argv[2] || 'HEAD'
  
  console.log(`Moving canary tag to: ${target}`)
  
  // Get the token
  const token = getGitToken()
  
  // Resolve the target to a SHA
  let sha
  try {
    sha = execSync(`git rev-parse ${target}`, { encoding: 'utf8' }).trim()
  } catch {
    console.error(`Error: Invalid ref: ${target}`)
    process.exit(1)
  }
  
  console.log(`Resolved SHA: ${sha}`)
  
  // Get list of changed files (compare to main)
  let changedFiles = []
  try {
    const diff = execSync('git diff --name-only origin/main...HEAD', { encoding: 'utf8' })
    changedFiles = diff.split('\n').filter(Boolean)
  } catch {
    // If no main branch or no changes, use empty list
    console.log('Warning: Could not compute changed files, running all targets')
  }
  
  // Load canary map and compute targets
  const mapContent = readFileSync('.github/canary-map.yml', 'utf8')
  const map = parse(mapContent)
  const targets = computeTargets(changedFiles, map.rules)
  
  console.log(`\nComputed targets: ${JSON.stringify(targets)}`)
  
  if (targets.length === 0) {
    console.log('No targets to run')
    process.exit(0)
  }
  
  // Delete existing canary tag
  console.log('\nDeleting existing canary tag...')
  run('git tag -d canary 2>/dev/null || true')
  run('git push origin :refs/tags/canary 2>/dev/null || true')
  
  // Create new canary tag
  console.log(`Creating new canary tag on ${sha}...`)
  run(`git tag canary ${sha}`)
  run('git push origin canary')
  
  console.log('✓ Canary tag updated')
  
  // Dispatch to blog
  await dispatchToBlog(token, targets)
}

main()
