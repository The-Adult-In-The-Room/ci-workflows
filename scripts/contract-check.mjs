#!/usr/bin/env node
// Contract validation for this repository's reusable workflows and composite
// actions. See issue #3 for the rationale.
//
// actionlint checks that the YAML is *structurally* valid. It cannot see the
// bugs that actually cost us consumers, because every one of them was a valid
// document with a broken *interface*:
//
//   - a composite action using `uses: ./…`, which silently resolves against
//     the consumer's workspace instead of this repo
//   - `run: npm run ${{ inputs.command }}` with a default of
//     `npm run test:e2e:acceptance`, producing `npm run npm run …`
//   - a `required: true` secret a consumer cannot discover, so they guess
//     `secrets: inherit` and it does not work
//   - `@v1` on a repo that only publishes `vX.Y.Z`, which fails at
//     "Prepare all required actions" rather than at review time
//   - an artifact name interpolated straight from an input, where upload-artifact
//     rejects the `:` in a colon-delimited npm script name — and only on a
//     failing run, because the upload is `if: failure()`
//
// So: static analysis over `.github/**`, six rules, every violation reported
// with a file and line. Deliberately not a runtime test — see issue #5.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'

// If you fork this repo, update this constant (and the matching Dependabot
// `ignore` pattern) to your owner/repo, or rule 2 silently stops matching.
const SELF_REPO = 'The-Adult-In-The-Room/ci-workflows'

// A ref we are willing to resolve without asking a human: an exact semver tag,
// or a full commit SHA. Anything else — `main`, `master`, a floating `v1` —
// is a ref that can move or fail to exist under us.
const SHA_REF = /^[0-9a-f]{40}$/
const SEMVER_TAG = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

const SKIP_DIRS = new Set(['node_modules', '.git'])

// Actions whose `name` input upload-artifact/download-artifact require to be
// filesystem-agnostic. Matched on owner/repo, so a pinned or floating tag is
// irrelevant — the constraint is the action's, not the ref's.
const ARTIFACT_ACTIONS = new Set(['actions/upload-artifact', 'actions/download-artifact'])

// A `${{ … }}` expression, and the `inputs.` references inside one. The
// lookbehind keeps `github.event.inputs.foo` from being read as a reference to a
// declared input, which is the one realistic false positive here.
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g
const INPUT_REFERENCE = /(?<![\w.])inputs\.([A-Za-z0-9_-]+)/g

const inputReferences = (expression) => [...expression.matchAll(INPUT_REFERENCE)].map(([, name]) => name)

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Maps character offsets in `text` to 1-based line/column pairs. */
function positionResolver(text) {
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStarts.push(i + 1)
  }
  return (offset) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (lineStarts[mid] <= offset) low = mid
      else high = mid - 1
    }
    return { line: low + 1, column: offset - lineStarts[low] + 1 }
  }
}

/**
 * Depth-first search for every value stored under a given mapping key,
 * regardless of type. Filter with `isStringLeaf` when only scalars will do.
 */
function findByKey(value, path, key, found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findByKey(item, [...path, index], key, found))
  } else if (isPlainObject(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      const childPath = [...path, childKey]
      if (childKey === key) found.push({ value: childValue, path: childPath })
      findByKey(childValue, childPath, key, found)
    }
  }
  return found
}

const isStringLeaf = ({ value }) => typeof value === 'string'

/** Every string scalar at or below `value`, with its path. */
function findStringLeaves(value, path, found = []) {
  if (typeof value === 'string') {
    found.push({ value, path })
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => findStringLeaves(item, [...path, index], found))
  } else if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      findStringLeaves(child, [...path, key], found)
    }
  }
  return found
}

/**
 * Gathers the input definitions a document declares. Composite actions declare
 * them at the top level; workflows declare them per trigger.
 */
function collectInputs(root) {
  const inputs = new Map()
  const record = (definitions, basePath) => {
    if (!isPlainObject(definitions)) return
    for (const [name, definition] of Object.entries(definitions)) {
      const def = isPlainObject(definition) ? definition : {}
      inputs.set(name, {
        name,
        path: [...basePath, name],
        hasDefault: Object.hasOwn(def, 'default'),
        defaultValue: typeof def.default === 'string' ? def.default : null,
        required: def.required === true,
        hasType: Object.hasOwn(def, 'type'),
      })
    }
  }

  record(root.inputs, ['inputs'])
  if (isPlainObject(root.on)) {
    for (const [triggerName, trigger] of Object.entries(root.on)) {
      record(trigger?.inputs, ['on', triggerName, 'inputs'])
    }
  }
  return inputs
}

function collectSecrets(root) {
  const secrets = []
  if (!isPlainObject(root.on)) return secrets
  for (const [triggerName, trigger] of Object.entries(root.on)) {
    if (!isPlainObject(trigger?.secrets)) continue
    for (const [name, definition] of Object.entries(trigger.secrets)) {
      const def = isPlainObject(definition) ? definition : {}
      secrets.push({
        name,
        path: ['on', triggerName, 'secrets', name],
        required: def.required === true,
        description: typeof def.description === 'string' ? def.description.trim() : '',
      })
    }
  }
  return secrets
}

const describe = (input) =>
  input.hasDefault ? `default ${JSON.stringify(input.defaultValue)}` : 'no default'

/**
 * Every step in the document, with its path. Workflow steps hang off each job;
 * a composite action has a single `runs.steps` list instead.
 */
function collectSteps(root) {
  const steps = []
  for (const [jobName, job] of Object.entries(root?.jobs ?? {})) {
    for (const [index, step] of (Array.isArray(job?.steps) ? job.steps : []).entries()) {
      if (isPlainObject(step)) steps.push({ step, path: ['jobs', jobName, 'steps', index] })
    }
  }
  for (const [index, step] of (Array.isArray(root?.runs?.steps) ? root.runs.steps : []).entries()) {
    if (isPlainObject(step)) steps.push({ step, path: ['runs', 'steps', index] })
  }
  return steps
}

/**
 * Checks one YAML document. Returns a flat list of violations, each carrying
 * the rule id, message, and source position.
 */
export function analyzeSource(text, { file = '<input>' } = {}) {
  const doc = parseDocument(text)
  const positionAt = positionResolver(text)
  const violations = []

  const report = (rule, message, path) => {
    const node = doc.getIn(path, true)
    const { line, column } = positionAt(node?.range?.[0] ?? 0)
    violations.push({ file, rule, message, line, column })
  }

  // A file we cannot parse would otherwise pass every rule vacuously.
  //
  // The `lint` job now runs mpalmer/action-validator against the composite
  // actions under `.github/actions`, so those files get proper schema
  // validation. `parse-error` remains as a backstop: it keeps the contract
  // checker from silently swallowing unparseable YAML, and it lets `npm run
  // contract` surface gross syntax errors even when action-validator is not
  // installed locally.
  for (const error of doc.errors) {
    const { line, column } = positionAt(error.pos?.[0] ?? 0)
    violations.push({
      file,
      rule: 'parse-error',
      message: error.message.split('\n')[0],
      line,
      column,
    })
  }
  if (doc.errors.length > 0) return violations

  const root = doc.toJS() ?? {}
  const inputs = collectInputs(root)
  const isCompositeAction = root?.runs?.using === 'composite'
  const declaresWorkflowCallInputs = isPlainObject(root?.on?.workflow_call?.inputs)
  const usesRefs = findByKey(root, [], 'uses').filter(isStringLeaf)
  const runSteps = findByKey(root, [], 'run').filter(isStringLeaf)

  // Rule 1 — no relative `uses:` inside a composite action.
  //
  // A workflow may legitimately use `uses: ./.github/workflows/x.yml`; that
  // resolves within the same repo. A *composite action* may not, because its
  // steps run in the consumer's checkout, where that path means something else.
  if (isCompositeAction) {
    for (const { value, path } of usesRefs) {
      if (value.startsWith('./')) {
        report(
          'no-relative-uses-in-composite-action',
          `relative \`uses: ${value}\` resolves against the consumer's workspace, not this repo; use a fully qualified ${SELF_REPO}/…@<tag> reference`,
          path,
        )
      }
    }
  }

  for (const { value, path } of usesRefs) {
    // Rule 2 — self-references must be immutable tags or SHAs.
    if (!value.startsWith(`${SELF_REPO}/`)) continue
    const ref = value.slice(SELF_REPO.length + 1).split('@')[1]
    if (ref === undefined || (SEMVER_TAG.test(ref) || SHA_REF.test(ref))) continue
    report(
      'no-branch-refs-for-self-references',
      `self-reference \`${value}\` uses ref \`${ref}\`, which is neither an exact semver tag nor a commit SHA; branch and floating refs break every consumer pinned to the current release`,
      path,
    )
  }

  // Rule 3 — input completeness.
  //
  // An input handed to something that will execute must be impossible to omit:
  // either a `default`, or `required: true`. That covers both consumption sites
  // — a `run:` body, and a `with:` value forwarded into another action.
  //
  // (The issue text says only "every input forwarded into a `run:` has a
  // `default`", but `playwright-test`'s `command` is required with no default,
  // so the literal reading rejects a correct file; and `verify.yml` forwards
  // `node-version-file` through `with:`, which the narrow reading misses
  // entirely. The intent is that omission cannot produce a half-formed command,
  // and `required: true` satisfies that.)
  if (declaresWorkflowCallInputs) {
    for (const input of inputs.values()) {
      if (!input.hasType) {
        report(
          'input-completeness',
          `workflow_call input \`${input.name}\` does not declare a \`type\``,
          input.path,
        )
      }
    }
  }

  const consumptionSites = [
    ...runSteps,
    // `with:` values are the other way an input's value gets consumed, and the
    // more dangerous one: an empty `node-version-file` reaches setup-node as an
    // empty string rather than as a visible syntax error.
    ...findByKey(root, [], 'with').flatMap(({ value, path }) =>
      findStringLeaves(value, path),
    ),
  ]

  for (const { value, path } of consumptionSites) {
    for (const expression of value.matchAll(EXPRESSION)) {
      for (const name of inputReferences(expression[1])) {
        const input = inputs.get(name)
        if (!input) {
          report(
            'input-completeness',
            `references \`inputs.${name}\`, which is not a declared input`,
            path,
          )
        } else if (!input.hasDefault && !input.required) {
          report(
            'input-completeness',
            `forwards \`inputs.${name}\` (${describe(input)}) into something that executes it, so omitting it produces a half-formed command; add a \`default\` or set \`required: true\``,
            path,
          )
        }
      }
    }
  }

  for (const { value, path } of runSteps) {
    // Rule 4 — script-name discipline.
    //
    // An input spliced after a literal `npm run` must carry a bare script name.
    // A default that already contains `npm run` yields `npm run npm run …`.
    for (const expression of value.matchAll(EXPRESSION)) {
      if (!/\bnpm\s+run\s*$/.test(value.slice(0, expression.index))) continue
      for (const name of inputReferences(expression[1])) {
        const input = inputs.get(name)
        if (input?.defaultValue && /\bnpm\s+run\b/.test(input.defaultValue)) {
          report(
            'script-name-discipline',
            `input \`${name}\` is spliced after \`npm run\` but defaults to \`${input.defaultValue}\`, producing \`npm run ${input.defaultValue}\`; the default must be a bare script name`,
            [...input.path, 'default'],
          )
        }
      }
    }
  }

  // Rule 5 — required secrets are documented.
  //
  // This does not stop a consumer passing the wrong secrets; it makes the
  // contract discoverable instead of tribal knowledge.
  for (const secret of collectSecrets(root)) {
    if (secret.required && secret.description === '') {
      report(
        'required-secrets-documented',
        `required secret \`${secret.name}\` has no \`description\`, so consumers cannot tell what to pass`,
        secret.path,
      )
    }
  }

  // Rule 6 — artifact names must not interpolate an input.
  //
  // `upload-artifact` rejects `" : < > | * ? \r \n \ /` in a name outright,
  // because downloads land on NTFS volumes where those are path separators or
  // reserved characters. Whether an input carries one is unknowable at review
  // time — `test:e2e:regression` is a perfectly good npm script name and an
  // invalid artifact name — so the only sound rule is that an input must not
  // reach the name unchecked.
  //
  // Note this bites hardest exactly when it is least visible: the upload is
  // `if: failure()`, so a green run never evaluates the name and the contract
  // only breaks on the run where someone needs the report.
  //
  // The fix is to derive the name in a step and forward the *output*, which is
  // the one value this document controls. `steps.*.outputs.*` is therefore
  // allowed, and `inputs.*` is not.
  for (const { step, path } of collectSteps(root)) {
    if (typeof step.uses !== 'string') continue
    const ownerRepo = step.uses.split('@')[0]
    if (!ARTIFACT_ACTIONS.has(ownerRepo)) continue

    const name = step.with?.name
    if (typeof name !== 'string') continue

    for (const expression of name.matchAll(EXPRESSION)) {
      for (const input of inputReferences(expression[1])) {
        report(
          'artifact-name-safety',
          `artifact name interpolates \`inputs.${input}\`, whose runtime value cannot be checked against the characters upload-artifact rejects (" : < > | * ? \\r \\n \\ /); derive a sanitised name in a step and pass \`steps.<id>.outputs.<name>\` instead`,
          [...path, 'with', 'name'],
        )
      }
    }
  }

  return violations
}

/** Every `.yml`/`.yaml` file under a path, recursively. */
export function yamlFilesUnder(target) {
  const stats = statSync(target)
  if (stats.isFile()) return [target]
  if (!stats.isDirectory()) return []

  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : yamlFilesUnder(join(target, entry.name))
    }
    return /\.ya?ml$/.test(entry.name) ? [join(target, entry.name)] : []
  })
}

/** Checks every workflow and action definition at or under the given paths. */
export function checkPaths(paths) {
  const cwd = process.cwd()
  return paths
    .flatMap((path) => yamlFilesUnder(path))
    .flatMap((path) =>
      analyzeSource(readFileSync(path, 'utf8'), { file: relative(cwd, path) || path }),
    )
}

function main(argv) {
  const targets = argv.length > 0 ? argv : ['.github']
  let violations
  try {
    violations = checkPaths(targets)
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`contract: no such file or directory: ${error.path ?? error.message}`)
      return 2
    }
    throw error
  }

  if (violations.length === 0) {
    console.log(`contract: ${targets.join(', ')} satisfies every rule.`)
    return 0
  }

  const width = Math.max(...violations.map((v) => `${v.file}:${v.line}:${v.column}`.length))
  for (const { file, rule, message, line, column } of violations) {
    console.error(`${`${file}:${line}:${column}`.padEnd(width)}  [${rule}]\n    ${message}`)
  }
  console.error(`\ncontract: ${violations.length} violation(s).`)
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}