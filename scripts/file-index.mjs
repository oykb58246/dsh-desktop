import { open, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
export const FILE_INDEX_PATH = path.join(root, 'website', 'download', 'file-index.json')
export const PATCH_META_PATH = path.join(root, 'website', 'download', 'patch.json')
const REMOTE_INDEX = 'https://raw.githubusercontent.com/oykb58246/dsh-desktop/main/website/download/file-index.json'

export function toIndexEntries(files) {
  return files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 }))
}

export function buildFileIndex(version, shellFiles, runtimeFiles) {
  return {
    version: String(version),
    generatedAt: new Date().toISOString(),
    shell: toIndexEntries(shellFiles),
    runtime: toIndexEntries(runtimeFiles),
  }
}

export async function writeFileIndex(index) {
  await mkdir(path.dirname(FILE_INDEX_PATH), { recursive: true })
  await writeFile(FILE_INDEX_PATH, JSON.stringify(index), 'utf8')
  const versioned = path.join(root, 'website', 'download', 'indexes', `file-index-${index.version}.json`)
  await mkdir(path.dirname(versioned), { recursive: true })
  await writeFile(versioned, JSON.stringify(index), 'utf8')
  return FILE_INDEX_PATH
}

export function diffFileIndex(previous, current) {
  const prevShell = new Map((previous?.shell ?? []).map((row) => [row.path, row]))
  const prevRuntime = new Map((previous?.runtime ?? []).map((row) => [row.path, row]))
  const nextShell = new Map((current?.shell ?? []).map((row) => [row.path, row]))
  const nextRuntime = new Map((current?.runtime ?? []).map((row) => [row.path, row]))

  const changed = (prev, next) => {
    const keep = []
    for (const [rel, row] of next) {
      const old = prev.get(rel)
      if (old === undefined || old.sha256 !== row.sha256 || old.size !== row.size) keep.push(rel)
    }
    return keep
  }
  const removed = (prev, next) => [...prev.keys()].filter((rel) => !next.has(rel))

  return {
    fromVersion: String(previous?.version ?? ''),
    toVersion: String(current?.version ?? ''),
    shellChanged: changed(prevShell, nextShell),
    runtimeChanged: changed(prevRuntime, nextRuntime),
    removeShell: removed(prevShell, nextShell),
    removeRuntime: removed(prevRuntime, nextRuntime),
  }
}

async function versionFromLatestYml() {
  try {
    const text = await readFile(path.join(root, 'website', 'download', 'latest.yml'), 'utf8')
    return text.match(/^version:\s*(\S+)/m)?.[1] ?? null
  } catch {
    return null
  }
}

export async function loadPreviousIndex(currentVersion) {
  try {
    const local = JSON.parse(await readFile(FILE_INDEX_PATH, 'utf8'))
    if (local?.version && local.version !== currentVersion) return local
  } catch { /* no local baseline yet */ }

  const setupExe = path.join(root, 'website', 'download', 'dsh-desktop-setup-x64.exe')
  const setupVersion = await versionFromLatestYml()
  if (setupVersion && setupVersion !== currentVersion) {
    try {
      return await readIndexFromInstaller(setupExe, setupVersion)
    } catch { /* setup exe missing or not a DSH payload */ }
  }

  try {
    const response = await fetch(REMOTE_INDEX, {
      headers: { 'user-agent': 'dsh-desktop-dist' },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.ok) {
      const remote = await response.json()
      if (remote?.version && remote.version !== currentVersion) return remote
    }
  } catch { /* offline / first publish */ }

  return null
}

async function readExact(handle, position, length) {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buf, 0, length, position)
  if (bytesRead !== length) throw new Error(`short read at ${position}`)
  return buf
}

/** Pull the per-file sha256 list out of an already-built setup exe. */
export async function readIndexFromInstaller(exePath, version) {
  const handle = await open(exePath, 'r')
  try {
    const st = await handle.stat()
    if (st.size < 12) throw new Error('installer too small')
    const tail = await readExact(handle, st.size - 12, 12)
    if (tail.subarray(4).toString('utf8') !== 'DSHPLD01') throw new Error('runtime section missing')
    const mlen = tail.readUInt32LE(0)
    const mbuf = await readExact(handle, st.size - 12 - mlen, mlen)
    const runtime = JSON.parse(mbuf.toString('utf8'))
    const runtimeManifestStart = st.size - 12 - mlen
    const shellEnd = runtime.files?.[0]?.offset ?? runtimeManifestStart
    const shellTail = await readExact(handle, shellEnd - 12, 12)
    if (shellTail.subarray(4).toString('utf8') !== 'DSHSHL01') throw new Error('shell section missing')
    const slen = shellTail.readUInt32LE(0)
    const sbuf = await readExact(handle, shellEnd - 12 - slen, slen)
    const shell = JSON.parse(sbuf.toString('utf8'))
    return buildFileIndex(version, shell.files ?? [], runtime.files ?? [])
  } finally {
    await handle.close()
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly && process.argv.includes('--from-setup')) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const exePath = path.join(root, 'website', 'download', 'dsh-desktop-setup-x64.exe')
  const index = await readIndexFromInstaller(exePath, pkg.version)
  await writeFileIndex(index)
  console.log(`Wrote file-index.json for v${index.version} (shell ${index.shell.length} + runtime ${index.runtime.length})`)
}
