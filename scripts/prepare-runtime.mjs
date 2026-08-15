import { cp, lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const stagingRoot = path.join(root, 'output', 'dsh-runtime')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${String(code)}`))
    })
  })
}

// Recursively copy a tree, following symbolic links and materializing their
// targets as real files/directories.  The installed kernel may contain links;
// the packaged app must not carry broken links, so every link is replaced by a
// full copy of what it points to.
async function copyFollowLinks(source, destination) {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    const stat = await lstat(from)
    if (stat.isSymbolicLink()) {
      const target = await readlink(from)
      await copyFollowLinks(path.resolve(path.dirname(from), target), to)
    } else if (stat.isDirectory()) {
      await copyFollowLinks(from, to)
    } else if (stat.isFile()) {
      await cp(from, to)
    }
  }
}

// Replace every symbolic link under dir with a real copy of its target.
async function dereferenceSymlinks(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const stat = await lstat(full)
    if (stat.isSymbolicLink()) {
      const target = await readlink(full)
      const resolved = path.resolve(path.dirname(full), target)
      await rm(full, { recursive: true, force: true })
      const targetStat = await lstat(resolved)
      if (targetStat.isDirectory()) await copyFollowLinks(resolved, full)
      else if (targetStat.isFile()) await cp(resolved, full)
    } else if (stat.isDirectory()) {
      await dereferenceSymlinks(full)
    }
  }
}

// Files that exist for building or debugging, never for running.  Licences and
// notices are kept regardless of extension; package.json is never touched.
const DROP_EXTENSIONS = new Set([
  '.pdb', '.map', '.ts', '.mts', '.cts', '.cc', '.cpp', '.hpp', '.markdown', '.md',
])

const KEEP_NAMES = [/^licen[cs]e/i, /^copying/i, /^notice/i, /^authors/i, /^patents/i]

const buildPlatform = `${process.platform}-${process.arch}`

function isForeignPrebuild(name) {
  if (!/^(win32|linux|darwin|android|freebsd)-/.test(name)) return false
  return name !== buildPlatform
}

// Packages that ship per-platform native binaries follow the
// "<name>-<platform>-<arch>[-suffix]" convention (sharp-win32-x64,
// lightningcss-linux-x64-gnu, ...).  Only the current platform's package is
// needed; the rest are dead weight in an offline payload.
const FOREIGN_PLATFORM_PACKAGE = /(?:^|-)(win32|windows|linux|darwin|android|freebsd)-(x64|arm64|ia32|arm)(?:-[a-z0-9]+)?$/i

function isForeignPlatformPackage(name) {
  const match = FOREIGN_PLATFORM_PACKAGE.exec(name)
  if (match === null) return false
  const platform = match[1].toLowerCase() === 'windows' ? 'win32' : match[1].toLowerCase()
  return platform !== process.platform || match[2] !== process.arch
}

async function pruneKernel(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (isForeignPrebuild(entry.name) || isForeignPlatformPackage(entry.name)) {
        await rm(full, { recursive: true, force: true })
        continue
      }
      await pruneKernel(full)
      continue
    }
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (!DROP_EXTENSIONS.has(ext)) continue
    const base = entry.name.slice(0, entry.name.length - ext.length)
    if (KEEP_NAMES.some((pattern) => pattern.test(base))) continue
    await rm(full, { force: true })
  }
}

const lock = JSON.parse(await readFile(path.join(root, 'upstream.lock.json'), 'utf8'))
const { name, version, integrity, bin } = lock.kernel
const spec = `${name}@${version}`
const harnessRoot = path.join(root, 'deepseek-harness')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

console.log(`installing ${spec} into ${stagingRoot}`)

await rm(stagingRoot, { recursive: true, force: true })
await mkdir(stagingRoot, { recursive: true })

// A private, versionless manifest: this directory is a payload, not a package.
await writeFile(
  path.join(stagingRoot, 'package.json'),
  `${JSON.stringify({ name: 'dsh-kernel-payload', private: true, version: '0.0.0' }, null, 2)}\n`,
  'utf8',
)

await run(
  npm,
  ['install', spec, '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--install-strategy=hoisted'],
  stagingRoot,
)

// Read the installed tree back and compare it against the pin.  npm reporting
// success means the command ran, not that what landed on disk is the artefact
// this repository pinned.
const lockfile = JSON.parse(await readFile(path.join(stagingRoot, 'package-lock.json'), 'utf8'))
const entry = lockfile.packages?.[`node_modules/${name}`]
if (entry === undefined) throw new Error(`${name} is absent from the installed tree`)
if (entry.version !== version) {
  throw new Error(`installed ${name}@${entry.version}, but upstream.lock.json pins ${version}`)
}
if (entry.integrity !== integrity) {
  throw new Error(`integrity mismatch for ${name}@${version}: expected ${integrity}, actual ${String(entry.integrity)}`)
}
if (!await lstat(path.join(stagingRoot, bin)).then(() => true, () => false)) {
  throw new Error(`the kernel entry point is missing at ${bin}`)
}
await rm(path.join(stagingRoot, 'package-lock.json'), { force: true })

// ---------- overlay the locally built harness over the npm kernel ----------
// The installer ships this repository's own deepseek-harness source (vision
// bridge, model-settings UI, and every other local change), not the registry
// snapshot alone: build the workspace, then replace each dsh-* package's lib/
// in the installed tree with the locally built one. The npm install above
// still supplies the complete dependency graph (native binaries, third-party
// deps, the web frontend skeleton), and package.json files keep their pinned
// versions so the kernel still reports the upstream.lock.json version.
const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack'

if (!existsSync(path.join(harnessRoot, 'node_modules'))) {
  console.log('deepseek-harness dependencies missing; installing…')
  await run(corepack, ['pnpm', 'install', '--dir', harnessRoot], root)
}
console.log('building the local deepseek-harness workspace…')
await run(corepack, ['pnpm', '--dir', harnessRoot, 'run', 'build'], root)

/** Local package directories carrying the built `lib/` of one dsh-* package. */
async function localPackageDirs() {
  const dirs = []
  const groups = await readdir(path.join(harnessRoot, 'packages'), { withFileTypes: true })
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const groupDir = path.join(harnessRoot, 'packages', group.name)
    for (const pkg of await readdir(groupDir, { withFileTypes: true })) {
      if (pkg.isDirectory()) dirs.push(path.join(groupDir, pkg.name))
    }
  }
  dirs.push(path.join(harnessRoot, 'apps', 'cli'))
  return dirs
}

/** The package name a local directory publishes under, or undefined. */
async function packageNameOf(dir) {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
    return typeof parsed?.name === 'string' ? parsed.name : undefined
  } catch {
    return undefined
  }
}

async function overlayLocalBuild() {
  let overlaid = 0
  let added = 0
  for (const dir of await localPackageDirs()) {
    const pkgName = await packageNameOf(dir)
    if (pkgName === undefined || !pkgName.startsWith('@deepseek-ai/dsh')) continue
    const localLib = path.join(dir, 'lib')
    if (!existsSync(localLib)) continue
    const installed = path.join(stagingRoot, 'node_modules', pkgName)
    if (existsSync(path.join(installed, 'lib'))) {
      // Kernel-shipped package: replace its lib/ with the locally built one.
      await rm(path.join(installed, 'lib'), { recursive: true, force: true })
      await copyFollowLinks(localLib, path.join(installed, 'lib'))
      // The composition manifest (a bundle's cordis.patch.yml) lives at the
      // package root, not in lib/. Local registrations — the vision bridge
      // entry among them — must ship too, or the kernel keeps the npm
      // snapshot's stale manifest and the plugin never loads.
      for (const extra of ['cordis.patch.yml', 'cordis.yml']) {
        const extraPath = path.join(dir, extra)
        if (existsSync(extraPath)) await cp(extraPath, path.join(installed, extra))
      }
      overlaid += 1
    } else if (!existsSync(installed)) {
      // Package absent from the npm kernel (a workspace-local addition such as
      // the vision bridge): ship only what runtime resolution needs. The whole
      // package tree is NOT copied — pnpm's per-package node_modules is full
      // of workspace symlinks, and following them would recursively copy the
      // entire workspace.
      await cp(path.join(dir, 'package.json'), path.join(installed, 'package.json'))
      await copyFollowLinks(localLib, path.join(installed, 'lib'))
      for (const extra of ['cordis.patch.yml']) {
        const extraPath = path.join(dir, extra)
        if (existsSync(extraPath)) await cp(extraPath, path.join(installed, extra))
      }
      added += 1
    }
  }
  // The browser surface: replace the frontend dist with the locally built one.
  const webName = await packageNameOf(path.join(harnessRoot, 'apps', 'web'))
  const webDist = path.join(harnessRoot, 'apps', 'web', 'dist')
  if (webName !== undefined && existsSync(webDist)) {
    const installedDist = path.join(stagingRoot, 'node_modules', webName, 'dist')
    await rm(installedDist, { recursive: true, force: true })
    await copyFollowLinks(webDist, installedDist)
    overlaid += 1
  }
  if (overlaid === 0 && added === 0) {
    throw new Error('the local harness build produced nothing to overlay; run the deepseek-harness build first')
  }
  console.log(`overlaid ${overlaid} existing and added ${added} local packages over the npm kernel`)
}

await overlayLocalBuild()

// Materialize any links so the packaged runtime works on machines without the
// build checkout, then drop sources, source maps, documentation and
// foreign-platform binaries that are never read at runtime.
await dereferenceSymlinks(stagingRoot)
await pruneKernel(stagingRoot)

console.log(`Prepared offline DSH runtime at ${stagingRoot}`)