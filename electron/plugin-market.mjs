/**
 * Desktop plugin market — browse the public GitHub `dsh-plugin` topic and
 * install into the local web profile (`dsh plugin --profile web add …`).
 *
 * DSH plugins are Cordis bundles: `dsh plugin` forwards to pnpm in
 * `$DSH_HOME/profiles/web`, then reconciles `dsh.profile.bundles`.
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, cpSync } from 'node:fs'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

const GITHUB_SEARCH = 'https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=30'
const USER_AGENT = 'dsh-desktop-plugin-market'

/** Hand-picked entries that show even when GitHub search is rate-limited. */
export const FEATURED_PLUGINS = [
  {
    name: 'dsh-plugin-marketplace',
    repo: 'AwesomeHou/dsh-plugin-marketplace',
    description: '设置页插件市场：同步 GitHub dsh-plugin 主题，支持搜索与一键安装',
    spec: 'github:AwesomeHou/dsh-plugin-marketplace',
    stars: null,
    kind: 'marketplace',
  },
  {
    name: 'dsh-find-plugin',
    repo: 'awesome-dsh-plugin/dsh-find-plugin',
    description: '会话内搜索 GitHub dsh-plugin 主题，按 star 排序发现插件',
    spec: 'github:awesome-dsh-plugin/dsh-find-plugin',
    stars: null,
    kind: 'discover',
  },
  {
    name: 'dsh-plugin-cc',
    repo: 'cpj-dev/dsh-plugin-cc',
    description: '桥接到 Claude Code：评审、批评、委派与会话导入',
    spec: 'github:cpj-dev/dsh-plugin-cc',
    stars: null,
    kind: 'bridge',
  },
  {
    name: 'superpowers-dsh',
    repo: 'LayneChai/superpowers-dsh',
    description: 'TDD、调试、规划与协作技能（obra/superpowers 的 DSH 移植）',
    spec: 'github:LayneChai/superpowers-dsh',
    stars: null,
    kind: 'skills',
  },
  {
    name: 'dsh-community-plugins',
    repo: 'HubaKing/dsh-community-plugins',
    description: '社区插件生态指南 skill：让每个会话知道如何发现与安装插件',
    spec: 'github:HubaKing/dsh-community-plugins',
    stars: null,
    kind: 'guide',
  },
  {
    name: 'Oh-My-DSH',
    repo: 'like-study1/Oh-My-DSH',
    description: '社区维护的 dsh-plugin 目录，定时同步公开主题',
    spec: 'github:like-study1/Oh-My-DSH',
    stars: null,
    kind: 'catalog',
  },
]

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function specFromRepo(fullName) {
  return `github:${fullName}`
}

/** Read the web profile's installed plugin dependencies. */
export async function listInstalledPlugins(dshHome) {
  const profileDir = path.join(dshHome, 'profiles', 'web')
  const manifestPath = path.join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    return { profileDir, exists: false, bundles: [], dependencies: [] }
  }
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
    const deps = parsed?.dependencies ?? {}
    const bundles = Array.isArray(parsed?.dsh?.profile?.bundles) ? parsed.dsh.profile.bundles : []
    const builtin = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'])
    const dependencies = Object.entries(deps).map(([name, spec]) => ({
      name,
      spec: String(spec),
      bundle: bundles.includes(name),
      builtin: builtin.has(name),
    }))
    return {
      profileDir,
      exists: true,
      bundles: bundles.filter((name) => !builtin.has(name)),
      dependencies: dependencies.filter((row) => !row.builtin),
    }
  } catch (error) {
    return { profileDir, exists: true, error: errorMessage(error), bundles: [], dependencies: [] }
  }
}

/** Search the public GitHub dsh-plugin topic, falling back to the featured list. */
export async function searchPlugins(query) {
  const featured = FEATURED_PLUGINS.map((row) => ({ ...row, source: 'featured' }))
  let remote = []
  let error = null
  try {
    const url = query && String(query).trim() !== ''
      ? `https://api.github.com/search/repositories?q=${encodeURIComponent(`${query} topic:dsh-plugin`)}&sort=stars&order=desc&per_page=30`
      : GITHUB_SEARCH
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
    const json = await response.json()
    const items = Array.isArray(json?.items) ? json.items : []
    remote = items.map((item) => ({
      name: item.name,
      repo: item.full_name,
      description: item.description ?? '',
      spec: specFromRepo(item.full_name),
      stars: typeof item.stargazers_count === 'number' ? item.stargazers_count : 0,
      url: item.html_url,
      kind: 'community',
      source: 'github',
    }))
  } catch (cause) {
    error = errorMessage(cause)
  }
  const seen = new Set(remote.map((row) => row.repo.toLowerCase()))
  const merged = [
    ...featured.filter((row) => !seen.has(row.repo.toLowerCase())),
    ...remote,
  ]
  return { plugins: merged, error, featured: featured.length, remote: remote.length }
}

function spawnDshPlugin(options, args) {
  return new Promise((resolve) => {
    const child = spawn(
      options.packaged ? process.execPath : 'node',
      [options.harnessEntry, 'plugin', '--profile', 'web', ...args],
      {
        cwd: options.harnessRoot,
        env: options.packaged
          ? { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: options.dshHome }
          : { ...process.env, DSH_HOME: options.dshHome },
        windowsHide: true,
        shell: false,
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', (error) => {
      resolve({ ok: false, code: 1, stdout, stderr: errorMessage(error) })
    })
    child.once('close', (code) => {
      resolve({ ok: code === 0, code: code ?? 1, stdout, stderr })
    })
  })
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function pluginRowId(name) {
  const cleaned = String(name).replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return cleaned === '' ? 'plugin' : cleaned
}

function parseGithubSpec(spec) {
  const github = /^github:([^/#\s]+)\/([^/#\s]+)(?:#([^\s]+))?$/i.exec(spec)
  if (github) {
    return { owner: github[1], repo: github[2].replace(/\.git$/i, ''), ref: github[3] ?? '' }
  }
  const url = /^https?:\/\/github\.com\/([^/#\s]+)\/([^/#\s]+?)(?:\.git)?(?:\/(?:tree|commit)\/([^/?#\s]+))?\/?$/i.exec(spec)
  if (url) {
    return { owner: url[1], repo: url[2], ref: url[3] ?? '' }
  }
  return null
}

function runTar(args) {
  return new Promise((resolve, reject) => {
    execFile('tar', args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message || error)))
      else resolve()
    })
  })
}

async function downloadGithubZip(owner, repo, ref) {
  const refs = ref !== ''
    ? [ref, `refs/heads/${ref}`, `refs/tags/${ref}`]
    : ['refs/heads/main', 'refs/heads/master']
  let lastError = '无法下载仓库'
  for (const item of refs) {
    const url = `https://codeload.github.com/${owner}/${repo}/zip/${item}`
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/octet-stream' },
        redirect: 'follow',
        signal: AbortSignal.timeout(60_000),
      })
      if (!response.ok) {
        lastError = `GitHub HTTP ${response.status}（${item}）`
        continue
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length < 64) {
        lastError = `下载内容过短（${item}）`
        continue
      }
      return buffer
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(lastError)
}

function findPackageRoot(dir) {
  if (existsSync(path.join(dir, 'package.json'))) return dir
  for (const name of readdirSync(dir)) {
    const child = path.join(dir, name)
    try {
      if (statSync(child).isDirectory() && existsSync(path.join(child, 'package.json'))) return child
    } catch {
      // Skip unreadable entries.
    }
  }
  return null
}

function registerProfilePlugin(profileDir, pkgName, spec, isBundle) {
  const manifestFile = path.join(profileDir, 'package.json')
  const manifest = readJson(manifestFile, { name: 'dsh-profile-web', private: true })
  if (!manifest.dependencies || typeof manifest.dependencies !== 'object') manifest.dependencies = {}
  manifest.dependencies[pkgName] = spec
  if (!manifest.dsh || typeof manifest.dsh !== 'object') manifest.dsh = {}
  if (!manifest.dsh.profile || typeof manifest.dsh.profile !== 'object') manifest.dsh.profile = {}
  if (!Array.isArray(manifest.dsh.profile.bundles)) {
    manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  }
  if (isBundle && !manifest.dsh.profile.bundles.includes(pkgName)) {
    manifest.dsh.profile.bundles.push(pkgName)
  }
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')

  if (isBundle) return
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const id = pluginRowId(pkgName)
  let patch = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  if (new RegExp(`(?:^|\\n)\\s*-?\\s*id\\s*:\\s*${id}\\b`).test(`\n${patch}`)) return
  const block = `- insert:\n    - id: ${id}\n      name: '${pkgName}'\n`
  if (patch.trim() === '') patch = '# dsh web profile patch（由 DSH Desktop 维护）\n' + block
  else patch = patch.replace(/\s*$/, '\n') + block
  writeFileSync(patchFile, patch)
}

function unregisterProfilePlugin(profileDir, pkgName) {
  const manifestFile = path.join(profileDir, 'package.json')
  const manifest = readJson(manifestFile, null)
  if (manifest) {
    if (manifest.dependencies && typeof manifest.dependencies === 'object') {
      delete manifest.dependencies[pkgName]
    }
    const bundles = manifest.dsh?.profile?.bundles
    if (Array.isArray(bundles)) {
      manifest.dsh.profile.bundles = bundles.filter((name) => name !== pkgName)
    }
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  }
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchFile)) return
  const id = pluginRowId(pkgName)
  const next = readFileSync(patchFile, 'utf8')
    .replace(new RegExp(`(?:\\r?\\n)?- insert:\\r?\\n\\s+- id: ${id}\\b[^\\n]*\\r?\\n\\s+name: ['"]${pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*`, 'g'), '\n')
  writeFileSync(patchFile, next)
}

async function copyPluginIntoProfile(dshHome, sourceDir, spec) {
  const pkg = readJson(path.join(sourceDir, 'package.json'), null)
  const pkgName = typeof pkg?.name === 'string' && pkg.name !== '' ? pkg.name : null
  if (pkgName === null) return { ok: false, error: '插件包缺少 package.json name' }
  const profileDir = path.join(dshHome, 'profiles', 'web')
  const dest = path.join(profileDir, 'node_modules', pkgName)
  mkdirSync(path.dirname(dest), { recursive: true })
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  cpSync(sourceDir, dest, { recursive: true, force: true })
  const isBundle = pkg?.dsh?.bundle?.patch !== undefined
  registerProfilePlugin(profileDir, pkgName, spec, isBundle)
  return { ok: true, name: pkgName, bundle: isBundle }
}

async function installPluginNative(dshHome, spec) {
  if (spec.startsWith('file:')) {
    const from = spec.slice('file:'.length)
    if (!existsSync(from)) return { ok: false, error: `本地路径不存在：${from}` }
    return copyPluginIntoProfile(dshHome, from, spec)
  }
  const github = parseGithubSpec(spec)
  if (github === null) {
    return { ok: false, error: '当前环境无法走官方 pnpm 通道，只支持 github:owner/repo 或本地 file: 路径' }
  }
  const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-plugin-'))
  try {
    const zipPath = path.join(scratch, 'plugin.zip')
    writeFileSync(zipPath, await downloadGithubZip(github.owner, github.repo, github.ref))
    const unpacked = path.join(scratch, 'unpacked')
    mkdirSync(unpacked, { recursive: true })
    await runTar(['-xf', zipPath, '-C', unpacked])
    const root = findPackageRoot(unpacked)
    if (root === null) return { ok: false, error: '下载的仓库里没有 package.json' }
    const result = await copyPluginIntoProfile(dshHome, root, `github:${github.owner}/${github.repo}${github.ref ? '#' + github.ref : ''}`)
    if (result.ok) result.log = `已从 GitHub 安装 ${result.name}`
    return result
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

function removePluginNative(dshHome, name) {
  const profileDir = path.join(dshHome, 'profiles', 'web')
  const dest = path.join(profileDir, 'node_modules', name)
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  unregisterProfilePlugin(profileDir, name)
  return { ok: true, name }
}

/** Install one plugin spec into the web profile. */
export async function installPlugin(options, spec) {
  const cleaned = String(spec ?? '').trim()
  if (cleaned === '') return { ok: false, error: '缺少插件规格' }

  const tryNative = async () => installPluginNative(options.dshHome, cleaned)

  if (options.packaged) {
    const native = await tryNative()
    if (native.ok) {
      return { ok: true, spec: cleaned, log: native.log || `已安装 ${native.name}` }
    }
    const result = await spawnDshPlugin(options, ['add', cleaned])
    if (result.ok) {
      return { ok: true, spec: cleaned, log: (result.stdout + '\n' + result.stderr).trim() }
    }
    const log = (result.stdout + '\n' + result.stderr).trim()
    return {
      ok: false,
      spec: cleaned,
      error: native.error || log || '安装失败',
      command: `dsh plugin --profile web add ${cleaned}`,
    }
  }

  const result = await spawnDshPlugin(options, ['add', cleaned])
  if (result.ok) {
    return { ok: true, spec: cleaned, log: (result.stdout + '\n' + result.stderr).trim() }
  }
  const log = (result.stdout + '\n' + result.stderr).trim()
  const missingPnpm = /pnpm not found/i.test(log) || result.code === 127
  if (missingPnpm || parseGithubSpec(cleaned) !== null || cleaned.startsWith('file:')) {
    const native = await tryNative()
    if (native.ok) {
      return { ok: true, spec: cleaned, log: native.log || `已安装 ${native.name}` }
    }
    return {
      ok: false,
      spec: cleaned,
      error: native.error || (missingPnpm
        ? '本机未找到 pnpm，且无法直接安装该规格。请改用 github:owner/repo'
        : log),
      command: `dsh plugin --profile web add ${cleaned}`,
    }
  }
  return {
    ok: false,
    spec: cleaned,
    error: log || `安装失败（退出码 ${result.code}）`,
    command: `dsh plugin --profile web add ${cleaned}`,
  }
}

/** Remove one installed plugin from the web profile. */
export async function removePlugin(options, name) {
  const cleaned = String(name ?? '').trim()
  if (cleaned === '') return { ok: false, error: '缺少插件名' }
  const result = await spawnDshPlugin(options, ['remove', cleaned])
  if (result.ok) return { ok: true, name: cleaned }
  const log = (result.stdout + '\n' + result.stderr).trim()
  const missingPnpm = /pnpm not found/i.test(log) || result.code === 127
  if (options.packaged || missingPnpm) {
    return removePluginNative(options.dshHome, cleaned)
  }
  return {
    ok: false,
    name: cleaned,
    error: log || `卸载失败（退出码 ${result.code}）`,
  }
}

/** List plugin folders already dropped into $DSH_HOME/community-plugins. */
export async function listLocalDrops(dshHome) {
  const root = path.join(dshHome, 'community-plugins')
  if (!existsSync(root)) return []
  try {
    const names = await readdir(root, { withFileTypes: true })
    return names.filter((entry) => entry.isDirectory()).map((entry) => ({
      name: entry.name,
      path: path.join(root, entry.name),
      spec: `file:${path.join(root, entry.name)}`,
    }))
  } catch {
    return []
  }
}
