/**
 * Desktop plugin market — browse the public GitHub `dsh-plugin` topic and
 * install into the local web profile (`dsh plugin --profile web add …`).
 *
 * DSH plugins are Cordis bundles: `dsh plugin` forwards to pnpm in
 * `$DSH_HOME/profiles/web`, then reconciles `dsh.profile.bundles`.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

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

/** Install one plugin spec into the web profile. */
export async function installPlugin(options, spec) {
  const cleaned = String(spec ?? '').trim()
  if (cleaned === '') return { ok: false, error: '缺少插件规格' }
  const result = await spawnDshPlugin(options, ['add', cleaned])
  if (result.ok) {
    return { ok: true, spec: cleaned, log: (result.stdout + '\n' + result.stderr).trim() }
  }
  const log = (result.stdout + '\n' + result.stderr).trim()
  const missingPnpm = /pnpm not found/i.test(log) || result.code === 127
  return {
    ok: false,
    spec: cleaned,
    error: missingPnpm
      ? '本机未找到 pnpm。请先安装 pnpm，或在终端执行：dsh plugin --profile web add ' + cleaned
      : (log || `安装失败（退出码 ${result.code}）`),
    command: `dsh plugin --profile web add ${cleaned}`,
  }
}

/** Remove one installed plugin from the web profile. */
export async function removePlugin(options, name) {
  const cleaned = String(name ?? '').trim()
  if (cleaned === '') return { ok: false, error: '缺少插件名' }
  const result = await spawnDshPlugin(options, ['remove', cleaned])
  if (result.ok) return { ok: true, name: cleaned }
  return {
    ok: false,
    name: cleaned,
    error: (result.stdout + '\n' + result.stderr).trim() || `卸载失败（退出码 ${result.code}）`,
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
