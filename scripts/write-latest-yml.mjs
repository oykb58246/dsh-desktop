import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PATCH_META_PATH } from './file-index.mjs'

// Write website/download/latest.yml — the official update baseline consumed by
// the built-in updater (electron/updater.mjs). The manifest carries version +
// sha512 + size; the payload URL points at the matching GitHub Release asset
// (the setup exe is far larger than GitHub's 100 MB per-file limit, so it can
// never live in the repository itself — it is published as a release asset).
// Optional `patches:` entries point at a same-format installer that only
// contains files that changed since the previous version.
const root = path.resolve(import.meta.dirname, '..')
const exePath = path.join(root, 'website', 'download', 'dsh-desktop-setup-x64.exe')
const ymlPath = path.join(root, 'website', 'download', 'latest.yml')
const REPO = 'oykb58246/dsh-desktop'

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const version = String(pkg.version ?? '').trim()
if (version === '') throw new Error('package.json is missing a version')

let size = 0
try {
  size = (await stat(exePath)).size
} catch {
  throw new Error(`setup exe missing at ${exePath} — run electron-builder first`)
}

const sha512 = createHash('sha512').update(await readFile(exePath)).digest('base64')
const assetUrl = `https://github.com/${REPO}/releases/download/v${version}/dsh-desktop-setup-x64.exe`

const lines = [
  'version: ' + version,
  'files:',
  '  - url: ' + assetUrl,
  '    sha512: ' + sha512,
  '    size: ' + size,
  'path: dsh-desktop-setup-x64.exe',
  'sha512: ' + sha512,
  `releaseDate: '${new Date().toISOString()}'`,
]

let patchNote = ''
try {
  const patch = JSON.parse(await readFile(PATCH_META_PATH, 'utf8'))
  const patchPath = path.join(root, 'website', 'download', patch.file)
  const patchSize = (await stat(patchPath)).size
  const patchSha = createHash('sha512').update(await readFile(patchPath)).digest('base64')
  const patchUrl = `https://github.com/${REPO}/releases/download/v${version}/${patch.file}`
  lines.push('patches:')
  lines.push('  - from: ' + patch.from)
  lines.push('    url: ' + patchUrl)
  lines.push('    sha512: ' + patchSha)
  lines.push('    size: ' + patchSize)
  patchNote = `, patch ${patch.file} (${patchSize} bytes)`
} catch {
  // No incremental payload for this build (first release, or identical tree).
}

lines.push('')
await writeFile(ymlPath, lines.join('\n'), 'utf8')
console.log(`Wrote ${ymlPath} (v${version}, ${size} bytes, sha512 pinned, asset: ${assetUrl}${patchNote})`)
