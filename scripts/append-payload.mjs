import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { cp, open, readdir, readFile, stat, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  buildFileIndex,
  diffFileIndex,
  loadPreviousIndex,
  writeFileIndex,
  PATCH_META_PATH,
} from './file-index.mjs'

// Assemble the final installer exe:
//
//   [Go loader exe][shell files][shell manifest][u32][DSHSHL01][runtime files][runtime manifest][u32][DSHPLD01]
//
// The loader (loader/main.go) extracts the shell to %TEMP%\dsh-desktop-installer
// with a progress UI; the installer worker reads the runtime section directly
// from this exe when installing. The shell comes from electron-builder's
// win-unpacked (no extraResources), the runtime from prepare-runtime's
// output/dsh-runtime (installed at <target>/resources/dsh-runtime).
const root = path.resolve(import.meta.dirname, '..')
const shellRoot = path.join(root, 'website', 'download', 'win-unpacked')
const runtimeRoot = path.join(root, 'output', 'dsh-runtime')
const loaderDir = path.join(root, 'loader')
const loaderExe = path.join(root, 'website', 'download', '.loader-tmp.exe')
const finalExe = path.join(root, 'website', 'download', 'dsh-desktop-setup-x64.exe')

const MAGIC_SHELL = 'DSHSHL01'
const MAGIC_RUNTIME = 'DSHPLD01'

async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

if (!(await stat(shellRoot)).isDirectory()) throw new Error(`shell dir missing: ${shellRoot}`)
if (!(await stat(runtimeRoot)).isDirectory()) throw new Error(`runtime dir missing: ${runtimeRoot}`)

// The loader embeds the whale icon for its window/taskbar.
await cp(path.join(root, 'assets', 'icon.ico'), path.join(loaderDir, 'icon.ico'))

console.log('building the native loader…')
// -H windowsgui: a console-subsystem exe makes Explorer open a black console
// window next to the installer on every double-click. GUI subsystem keeps the
// window clean; the reg/powershell children must then use CREATE_NO_WINDOW
// (see loader/main.go) or they would flash their own consoles during install.
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const appVersion = String(pkg.version ?? '').trim()
if (appVersion === '') throw new Error('package.json is missing a version')
execFileSync('go', ['build', '-ldflags', `-s -w -H windowsgui -X main.appVersion=${appVersion}`, '-o', loaderExe, '.'], { cwd: loaderDir, stdio: 'inherit' })

// Explorer needs the icon in the PE resources; rcedit runs BEFORE the payload
// containers are appended so the trailing data survives untouched. (The Go
// loader carries no version resource, so rcedit's version-string options are
// unavailable — only the icon is set.)
const pnpm = path.join(root, 'node_modules', '.pnpm')
const rceditDir = (await readdir(pnpm)).find((name) => name.startsWith('electron-winstaller@'))
if (rceditDir === undefined) throw new Error('rcedit.exe not found (electron-winstaller vendor)')
const rcedit = path.join(pnpm, rceditDir, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe')
execFileSync(rcedit, [loaderExe, '--set-icon', path.join(root, 'assets', 'icon.ico')], { stdio: 'ignore' })

console.log('building Uninstall.exe…')
const uninstallExe = path.join(shellRoot, 'Uninstall.exe')
execFileSync('go', ['build', '-ldflags', '-s -w -H windowsgui', '-o', uninstallExe, '.'], {
  cwd: path.join(root, 'uninstaller'),
  stdio: 'inherit',
})
execFileSync(rcedit, [uninstallExe, '--set-icon', path.join(root, 'assets', 'icon.ico')], { stdio: 'ignore' })

async function collect(dir) {
  const files = []
  const walk = async (d, prefix) => {
    const entries = await readdir(d, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(d, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(full, rel)
      else if (entry.isFile()) {
        const size = (await stat(full)).size
        files.push({ path: rel, full, size, sha256: await sha256File(full) })
      }
    }
  }
  await walk(dir, '')
  return files
}

console.log('collecting shell and runtime files…')
const shellFiles = (await collect(shellRoot)).sort((a, b) => a.size - b.size)
const runtimeFiles = (await collect(runtimeRoot)).sort((a, b) => a.size - b.size)
const loader = await readFile(loaderExe)

async function assembleInstaller(outPath, selectedShell, selectedRuntime, runtimeExtra = {}) {
  const shellManifest = { files: [] }
  let offset = loader.length
  for (const file of selectedShell) {
    shellManifest.files.push({ path: file.path, offset, size: file.size, sha256: file.sha256 })
    offset += file.size
  }
  const shellManifestBuf = Buffer.from(JSON.stringify(shellManifest))
  const shellEnd = offset + shellManifestBuf.length + 4 + 8

  const runtimeManifest = { ...runtimeExtra, shellManifestLen: shellManifestBuf.length, files: [] }
  offset = shellEnd
  for (const file of selectedRuntime) {
    runtimeManifest.files.push({ path: file.path, offset, size: file.size, sha256: file.sha256 })
    offset += file.size
  }
  const runtimeManifestBuf = Buffer.from(JSON.stringify(runtimeManifest))

  const shellLen = Buffer.alloc(4)
  shellLen.writeUInt32LE(shellManifestBuf.length, 0)
  const runtimeLen = Buffer.alloc(4)
  runtimeLen.writeUInt32LE(runtimeManifestBuf.length, 0)

  const handle = await open(outPath, 'w')
  try {
    await handle.writeFile(loader)
    for (const file of selectedShell) await handle.writeFile(await readFile(file.full))
    await handle.writeFile(shellManifestBuf)
    await handle.writeFile(shellLen)
    await handle.writeFile(Buffer.from(MAGIC_SHELL, 'utf8'))
    for (const file of selectedRuntime) await handle.writeFile(await readFile(file.full))
    await handle.writeFile(runtimeManifestBuf)
    await handle.writeFile(runtimeLen)
    await handle.writeFile(Buffer.from(MAGIC_RUNTIME, 'utf8'))
  } finally {
    await handle.close()
  }
}

const previousIndex = await loadPreviousIndex(appVersion)
const currentIndex = buildFileIndex(appVersion, shellFiles, runtimeFiles)
await writeFileIndex(currentIndex)
console.log(`Wrote file-index.json for v${appVersion} (shell ${shellFiles.length} + runtime ${runtimeFiles.length})`)

console.log(`assembling ${finalExe} (loader ${loader.length} + shell ${shellFiles.length} files + runtime ${runtimeFiles.length} files)`)
await assembleInstaller(finalExe, shellFiles, runtimeFiles)
console.log(`Wrote ${finalExe}`)

const byPath = (files) => new Map(files.map((file) => [file.path, file]))
if (previousIndex !== null) {
  const diff = diffFileIndex(previousIndex, currentIndex)
  const shellMap = byPath(shellFiles)
  const runtimeMap = byPath(runtimeFiles)
  const patchShell = diff.shellChanged.map((rel) => shellMap.get(rel)).filter(Boolean)
  const patchRuntime = diff.runtimeChanged.map((rel) => runtimeMap.get(rel)).filter(Boolean)
  const changed = patchShell.length + patchRuntime.length
  const removed = diff.removeShell.length + diff.removeRuntime.length
  if (changed === 0 && removed === 0) {
    await rm(PATCH_META_PATH, { force: true })
    console.log(`No file changes vs v${previousIndex.version}; skip patch installer`)
  } else {
    const patchName = `dsh-desktop-patch-${previousIndex.version}-${appVersion}-x64.exe`
    const patchExe = path.join(root, 'website', 'download', patchName)
    console.log(`assembling ${patchName} (${changed} changed + ${removed} removed vs v${previousIndex.version})`)
    await assembleInstaller(patchExe, patchShell, patchRuntime, {
      kind: 'patch',
      fromVersion: previousIndex.version,
      toVersion: appVersion,
      removeShell: diff.removeShell,
      removeRuntime: diff.removeRuntime,
    })
    await writeFile(PATCH_META_PATH, JSON.stringify({
      from: previousIndex.version,
      to: appVersion,
      file: patchName,
    }, null, 2), 'utf8')
    const patchSize = (await stat(patchExe)).size
    console.log(`Wrote ${patchExe} (${patchSize} bytes)`)
  }
} else {
  await rm(PATCH_META_PATH, { force: true })
  console.log('No previous file-index; this build is a full installer only. The next version can ship an incremental patch.')
}

await rm(loaderExe, { force: true })
