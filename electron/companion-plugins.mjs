/**
 * Sync companion DSH plugins into the local web profile, matching
 * myYangyunfan/dsh_desktop: copy package + register bundle / patch rows.
 *
 *   dsh-better-sidebar          VSCode-style right/bottom workbench
 *   @deepseek-ai/dsh-file-changes
 *   @deepseek-ai/dsh-client-file-changes
 */
import { existsSync, cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const COMPANIONS = [
  { id: 'better-sidebar', name: 'dsh-better-sidebar', dir: 'dsh-better-sidebar' },
  { id: 'file-changes', name: '@deepseek-ai/dsh-file-changes', dir: 'dsh-file-changes' },
  { id: 'client-file-changes', name: '@deepseek-ai/dsh-client-file-changes', dir: 'dsh-client-file-changes' },
]

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function copyDir(from, to) {
  mkdirSync(path.dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true, force: true })
}

function hoistNestedModules(from, to, log) {
  for (const name of readdirSync(from)) {
    if (name === '.bin') continue
    const src = path.join(from, name)
    const dest = path.join(to, name)
    try {
      copyDir(src, dest)
    } catch (error) {
      log('hoist ' + name + ' failed: ' + String(error))
    }
  }
}

/**
 * Install companion plugins into `$DSH_HOME/profiles/web`.
 * @param options.pluginsRoot - electron/plugins
 * @param options.dshHome - $DSH_HOME
 * @param options.harnessRoot - packaged or checkout harness
 * @param options.log - optional logger
 */
export function syncCompanionPlugins({ pluginsRoot, dshHome, harnessRoot, log = () => {} }) {
  const profileDir = path.join(dshHome, 'profiles', 'web')
  mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })

  const bundleNames = []
  for (const plugin of COMPANIONS) {
    const src = path.join(pluginsRoot, plugin.dir)
    if (!existsSync(path.join(src, 'package.json'))) {
      log('skip missing companion ' + plugin.dir)
      continue
    }
    const dest = path.join(profileDir, 'node_modules', plugin.name)
    copyDir(src, dest)
    const nested = path.join(dest, 'node_modules')
    if (existsSync(nested)) hoistNestedModules(nested, path.join(profileDir, 'node_modules'), log)
    const pkg = readJson(path.join(src, 'package.json'), {})
    if (pkg?.dsh?.bundle?.patch) bundleNames.push(plugin.name)
    log('synced ' + plugin.name)
  }

  vendorRuntimeDeps(profileDir, harnessRoot, log)

  const manifestFile = path.join(profileDir, 'package.json')
  const manifest = readJson(manifestFile, { name: 'dsh-profile-web', private: true })
  if (!manifest.dsh || typeof manifest.dsh !== 'object') manifest.dsh = {}
  if (!manifest.dsh.profile || typeof manifest.dsh.profile !== 'object') manifest.dsh.profile = {}
  if (!Array.isArray(manifest.dsh.profile.bundles)) {
    manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  }
  let bundlesChanged = false
  for (const name of bundleNames) {
    if (!manifest.dsh.profile.bundles.includes(name)) {
      manifest.dsh.profile.bundles.push(name)
      bundlesChanged = true
    }
  }
  if (bundlesChanged || !existsSync(manifestFile)) {
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  }

  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  let patch = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  let patchChanged = false
  for (const plugin of COMPANIONS) {
    if (bundleNames.includes(plugin.name)) continue
    if (new RegExp(`(?:^|\\n)\\s*-?\\s*id\\s*:\\s*${plugin.id}\\b`).test(`\n${patch}`)) continue
    const block = `- insert:\n    - id: ${plugin.id}\n      name: '${plugin.name}'\n`
    if (patch.trim() === '') patch = '# dsh web profile patch（由 DSH Desktop 维护）\n' + block
    else patch = patch.replace(/\s*$/, '\n') + block
    patchChanged = true
  }
  if (patchChanged) writeFileSync(patchFile, patch)
}

function vendorRuntimeDeps(profileDir, harnessRoot, log) {
  const destRoot = path.join(profileDir, 'node_modules')
  const copies = [
    { from: path.join(harnessRoot, 'vendor', 'schemastery'), to: path.join(destRoot, 'schemastery'), rename: 'schemastery' },
    { from: path.join(harnessRoot, 'vendor', 'cosmokit'), to: path.join(destRoot, 'cosmokit'), rename: null },
  ]
  for (const item of copies) {
    if (!existsSync(item.from)) continue
    try {
      copyDir(item.from, item.to)
      if (item.rename) {
        const pkgFile = path.join(item.to, 'package.json')
        const pkg = readJson(pkgFile, null)
        if (pkg) {
          pkg.name = item.rename
          writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
        }
      }
    } catch (error) {
      log('vendor copy failed ' + item.from + ': ' + String(error))
    }
  }
  copyPnpmPackage(harnessRoot, destRoot, 'ws@', 'ws', log)
  copyPnpmPackage(harnessRoot, destRoot, 'node-pty@', 'node-pty', log)
  copyPnpmPackage(harnessRoot, destRoot, '@standard-schema+spec@', path.join('@standard-schema', 'spec'), log)
}

function copyPnpmPackage(harnessRoot, destRoot, prefix, destName, log) {
  const pnpm = path.join(harnessRoot, 'node_modules', '.pnpm')
  if (!existsSync(pnpm)) return
  const match = readdirSync(pnpm).find((name) => name.startsWith(prefix))
  if (match === undefined) return
  const pkgName = destName.includes(path.sep) ? destName.split(path.sep).at(-1) : destName
  const from = path.join(pnpm, match, 'node_modules', destName.includes(path.sep) ? path.join(...destName.split(path.sep)) : pkgName)
  if (!existsSync(from)) return
  try {
    copyDir(from, path.join(destRoot, destName))
  } catch (error) {
    log('copy ' + destName + ' failed: ' + String(error))
  }
}
