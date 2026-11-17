#!/usr/bin/env node
// Local actionlint runner that mirrors the actionlint step in _self-check.yml.
//
// Reads the pinned actionlint version from .github/workflows/_self-check.yml,
// prefers a matching local binary on PATH, and otherwise downloads the pinned
// release for the host OS/arch into .cache/actionlint/.
//
// This keeps local feedback identical to CI without requiring actionlint to be
// installed globally. Run with `npm run lint`.

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..')

const SELF_CHECK_PATH = join(
  REPO_ROOT,
  '.github',
  'workflows',
  '_self-check.yml',
)

// Release-asset target triples, keyed on `${process.platform} ${process.arch}`.
const PLATFORM_ARCH_TO_TRIPLE: Record<string, string> = {
  'linux x64': 'linux_amd64',
  'linux arm64': 'linux_arm64',
  'darwin x64': 'darwin_amd64',
  'darwin arm64': 'darwin_arm64',
  'win32 x64': 'windows_amd64',
}

const SHELLCHECK_VERSION = '0.10.0'

const SHELLCHECK_PLATFORM_ARCH_TO_TRIPLE: Record<string, string> = {
  'linux x64': 'linux.x86_64',
  'linux arm64': 'linux.aarch64',
  'darwin x64': 'darwin.x86_64',
  'darwin arm64': 'darwin.aarch64',
  'win32 x64': 'windows.x86_64',
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PinnedVersionResult =
  | { ok: true; version: string }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Pinned rhysd/actionlint version from the `_self-check.yml` lint job. */
export function pinnedActionlintVersion(yamlText: string): PinnedVersionResult {
  const doc = parse(yamlText) as {
    jobs?: { lint?: { steps?: unknown } }
  } | null
  const steps = doc?.jobs?.lint?.steps

  if (!Array.isArray(steps)) {
    return {
      ok: false,
      error:
        'Could not find jobs.lint.steps in .github/workflows/_self-check.yml',
    }
  }

  for (const step of steps) {
    if (typeof step !== 'object' || step === null) continue
    const uses = (step as Record<string, unknown>).uses
    if (typeof uses !== 'string') continue

    const match = uses.trim().match(/^rhysd\/actionlint@v(\d+\.\d+\.\d+)$/)
    if (match) return { ok: true, version: match[1] }
  }

  return {
    ok: false,
    error:
      'Could not find rhysd/actionlint version in .github/workflows/_self-check.yml',
  }
}

/** Version from the first line of `actionlint --version` output. */
export function actionlintVersionFromOutput(stdout: string): string | null {
  const firstLine = stdout.split(/\r?\n/)[0].trim()
  const match = firstLine.match(/^(\d+\.\d+\.\d+)/)
  return match ? match[1] : null
}

/** Version from `shellcheck --version` output. */
export function shellcheckVersionFromOutput(stdout: string): string | null {
  const match = stdout.match(/version:\s*(\d+\.\d+\.\d+)/i)
  return match ? match[1] : null
}

/** Release-asset triple for a platform/arch pair, null if unsupported. */
export function tripleForPlatform(
  map: Record<string, string>,
  platform: string,
  arch: string,
): string | null {
  return map[`${platform} ${arch}`] ?? null
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function readPinnedVersion(): string {
  const result = pinnedActionlintVersion(readFileSync(SELF_CHECK_PATH, 'utf8'))
  if (!result.ok) fail(result.error)
  return result.version
}

function getTargetTriple(): string {
  const triple = tripleForPlatform(
    PLATFORM_ARCH_TO_TRIPLE,
    process.platform,
    process.arch,
  )

  if (!triple) {
    fail(
      `Unsupported platform/arch: ${process.platform} ${process.arch}. ` +
        `Supported: ${Object.keys(PLATFORM_ARCH_TO_TRIPLE).join(', ')}`,
    )
  }

  return triple
}

function binaryVersion(binPath: string): string | null {
  const result = spawnSync(binPath, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  })

  if (result.error || result.status !== 0) return null
  return actionlintVersionFromOutput(result.stdout)
}

function findLocalBinary(expectedVersion: string): string | null {
  const version = binaryVersion('actionlint')
  if (version === expectedVersion) {
    console.error(`Using local actionlint v${version} from PATH`)
    return 'actionlint'
  }

  if (version) {
    console.error(
      `Local actionlint v${version} does not match pinned v${expectedVersion}; downloading correct version`,
    )
  }

  return null
}

async function downloadActionlint(
  version: string,
  triple: string,
): Promise<string> {
  const cacheDir = join(REPO_ROOT, '.cache', 'actionlint')
  mkdirSync(cacheDir, { recursive: true })

  const isWindows = triple.startsWith('windows_')
  const extension = isWindows ? 'zip' : 'tar.gz'
  const assetName = `actionlint_${version}_${triple}.${extension}`
  const assetPath = join(cacheDir, assetName)
  const binName = isWindows ? 'actionlint.exe' : 'actionlint'
  const binPath = join(cacheDir, binName)

  const cachedVersion = existsSync(binPath) ? binaryVersion(binPath) : null
  if (cachedVersion === version) {
    console.error(`Using cached actionlint v${cachedVersion}`)
    return binPath
  }

  if (!existsSync(assetPath)) {
    const url = `https://github.com/rhysd/actionlint/releases/download/v${version}/${assetName}`
    console.error(`Downloading actionlint v${version} for ${triple} from ${url}`)

    const response = await fetch(url)
    if (!response.ok) {
      fail(`Download failed: ${response.status} ${response.statusText} (${url})`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    writeFileSync(assetPath, buffer)
  }

  console.error(`Extracting ${assetName}...`)

  if (isWindows) {
    const extract = spawnSync('powershell', [
      '-Command',
      `Expand-Archive -Path '${assetPath}' -DestinationPath '${cacheDir}' -Force`,
    ])
    if (extract.status !== 0) {
      fail('Failed to extract actionlint archive')
    }
  } else {
    const extract = spawnSync('tar', [
      '-xzf',
      assetPath,
      '-C',
      cacheDir,
      binName,
    ])
    if (extract.status !== 0) {
      fail('Failed to extract actionlint archive')
    }
    chmodSync(binPath, 0o755)
  }

  const extractedVersion = binaryVersion(binPath)
  if (extractedVersion !== version) {
    fail(
      `Extracted actionlint reports version ${extractedVersion}, expected ${version}`,
    )
  }

  console.error(`Using downloaded actionlint v${extractedVersion}`)
  return binPath
}

function shellcheckVersion(binPath: string): string | null {
  const result = spawnSync(binPath, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  })

  if (result.error || result.status !== 0) return null
  return shellcheckVersionFromOutput(result.stdout)
}

function findLocalShellcheck(): string | null {
  const version = shellcheckVersion('shellcheck')
  if (version) {
    console.error(`Using local shellcheck v${version} from PATH`)
    return 'shellcheck'
  }

  return null
}

function getShellcheckTriple(): string {
  const triple = tripleForPlatform(
    SHELLCHECK_PLATFORM_ARCH_TO_TRIPLE,
    process.platform,
    process.arch,
  )

  if (!triple) {
    fail(
      `Unsupported platform/arch for shellcheck: ${process.platform} ${process.arch}. ` +
        `Supported: ${Object.keys(SHELLCHECK_PLATFORM_ARCH_TO_TRIPLE).join(', ')}`,
    )
  }

  return triple
}

async function downloadShellcheck(triple: string): Promise<string> {
  const cacheDir = join(REPO_ROOT, '.cache', 'actionlint')
  mkdirSync(cacheDir, { recursive: true })

  const isWindows = process.platform === 'win32'
  const assetName = isWindows
    ? `shellcheck-v${SHELLCHECK_VERSION}.zip`
    : `shellcheck-v${SHELLCHECK_VERSION}.${triple}.tar.xz`
  const assetPath = join(cacheDir, assetName)
  const extractedDirName = `shellcheck-v${SHELLCHECK_VERSION}`
  const extractedDir = join(cacheDir, extractedDirName)
  const binName = isWindows ? 'shellcheck.exe' : 'shellcheck'
  const binPath = join(extractedDir, binName)

  const cachedVersion = existsSync(binPath) ? shellcheckVersion(binPath) : null
  if (cachedVersion === SHELLCHECK_VERSION) {
    console.error(`Using cached shellcheck v${cachedVersion}`)
    return binPath
  }

  if (!existsSync(assetPath)) {
    const url = `https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/${assetName}`
    console.error(
      `Downloading shellcheck v${SHELLCHECK_VERSION} for ${triple} from ${url}`,
    )

    const response = await fetch(url)
    if (!response.ok) {
      fail(`Download failed: ${response.status} ${response.statusText} (${url})`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    writeFileSync(assetPath, buffer)
  }

  console.error(`Extracting ${assetName}...`)

  if (isWindows) {
    const extract = spawnSync('powershell', [
      '-Command',
      `Expand-Archive -Path '${assetPath}' -DestinationPath '${extractedDir}' -Force`,
    ])
    if (extract.status !== 0) {
      fail('Failed to extract shellcheck archive')
    }
  } else {
    const extract = spawnSync('tar', ['-xJf', assetPath, '-C', cacheDir])
    if (extract.status !== 0) {
      fail('Failed to extract shellcheck archive')
    }
    chmodSync(binPath, 0o755)
  }

  const extractedVersion = shellcheckVersion(binPath)
  if (extractedVersion !== SHELLCHECK_VERSION) {
    fail(
      `Extracted shellcheck reports version ${extractedVersion}, expected ${SHELLCHECK_VERSION}`,
    )
  }

  console.error(`Using downloaded shellcheck v${extractedVersion}`)
  return binPath
}

function runActionlint(binPath: string, shellcheckPath: string | null): never {
  // Run actionlint in project mode so it discovers .github/workflows/*.yml
  // exactly as the rhysd/actionlint action does in CI. Point it at the same
  // shellcheck binary CI would use so shellcheck diagnostics (like SC2016)
  // surface locally too.
  const args = shellcheckPath ? ['-shellcheck', shellcheckPath] : []
  const result = spawnSync(binPath, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })

  process.exit(result.status ?? 1)
}

async function main(): Promise<void> {
  const version = readPinnedVersion()
  const triple = getTargetTriple()
  const shellcheckTriple = getShellcheckTriple()

  const localActionlint = findLocalBinary(version)
  const actionlintPath =
    localActionlint ?? (await downloadActionlint(version, triple))

  const localShellcheck = findLocalShellcheck()
  const shellcheckPath =
    localShellcheck ?? (await downloadShellcheck(shellcheckTriple))

  runActionlint(actionlintPath, shellcheckPath)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
