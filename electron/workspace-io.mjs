/**
 * Workspace I/O for the desktop cockpit: file tree, editor save, git
 * history / rollback, file checkpoints, and a workspace-scoped PowerShell.
 */
import { ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile, cp, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

const SKIP_DIR = new Set([
  'node_modules', '.git', '.dsh', 'dist', 'output', '.next', '.turbo',
  'website/download', 'win-unpacked',
])
const TEXT_EXT = new Set([
  'txt', 'md', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'html',
  'htm', 'yml', 'yaml', 'xml', 'svg', 'py', 'go', 'rs', 'java', 'kt', 'c',
  'h', 'cpp', 'hpp', 'cs', 'sh', 'ps1', 'bat', 'cmd', 'ini', 'toml', 'env',
  'gitignore', 'sql', 'vue', 'svelte', 'php', 'rb', 'swift', 'gradle',
])

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function resolveInside(root, rel) {
  const base = path.resolve(root)
  const full = path.resolve(base, rel ?? '')
  const prefix = base.toLowerCase()
  const target = full.toLowerCase()
  if (target !== prefix && !target.startsWith(prefix + path.sep)) {
    throw new Error('路径超出当前工作区')
  }
  return full
}

function execGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 30_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        ok: error == null,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error: error == null ? null : errorMessage(error),
      })
    })
  })
}

function workspaceKey(root) {
  return createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16)
}

export function registerWorkspaceIpc(options) {
  const { getWorkspaces, checkpointRoot, sendToMain } = options
  let term = null

  async function listWorkspaces() {
    try {
      return await getWorkspaces()
    } catch (error) {
      return { items: [], error: errorMessage(error) }
    }
  }

  ipcMain.handle('ws:list', () => listWorkspaces())

  ipcMain.handle('ws:tree', async (_event, payload) => {
    const root = String(payload?.root ?? '')
    const rel = String(payload?.rel ?? '')
    if (root === '') return { ok: false, error: '未选择工作区' }
    const dir = resolveInside(root, rel)
    const entries = await readdir(dir, { withFileTypes: true })
    const items = []
    for (const entry of entries) {
      if (SKIP_DIR.has(entry.name) || entry.name.startsWith('.')) {
        if (entry.name !== '.env' && entry.name !== '.gitignore') continue
      }
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      items.push({
        name: entry.name,
        rel: childRel.replaceAll('\\', '/'),
        dir: entry.isDirectory(),
      })
    }
    items.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'zh'))
    return { ok: true, items }
  })

  ipcMain.handle('ws:read', async (_event, payload) => {
    const root = String(payload?.root ?? '')
    const rel = String(payload?.rel ?? '')
    const full = resolveInside(root, rel)
    const info = await stat(full)
    if (info.isDirectory()) return { ok: false, error: '这是文件夹' }
    const ext = path.extname(full).slice(1).toLowerCase()
    if (info.size > 1_500_000) return { ok: false, error: '文件超过 1.5MB，请用系统编辑器打开', path: full }
    if (!TEXT_EXT.has(ext) && ext !== '') {
      return { ok: false, binary: true, path: full, size: info.size }
    }
    const text = await readFile(full, 'utf8')
    return { ok: true, text, path: full, rel, size: info.size }
  })

  ipcMain.handle('ws:write', async (_event, payload) => {
    const root = String(payload?.root ?? '')
    const rel = String(payload?.rel ?? '')
    const text = String(payload?.text ?? '')
    const full = resolveInside(root, rel)
    await writeFile(full, text, 'utf8')
    return { ok: true, path: full }
  })

  ipcMain.handle('ws:reveal', async (_event, payload) => {
    const full = String(payload?.path ?? '')
    if (full === '' || !existsSync(full)) return { ok: false }
    shell.showItemInFolder(full)
    return { ok: true }
  })

  ipcMain.handle('ws:open-external', async (_event, payload) => {
    const full = String(payload?.path ?? '')
    if (full === '') return { ok: false }
    await shell.openPath(full)
    return { ok: true }
  })

  ipcMain.handle('ws:history', async (_event, payload) => {
    const root = String(payload?.root ?? '')
    if (root === '' || !existsSync(path.join(root, '.git'))) {
      return { ok: true, git: false, commits: [], checkpoints: await listCheckpoints(root) }
    }
    const log = await execGit(root, [
      'log', '-n', '40', '--date=iso-strict', '--pretty=format:%H%x09%ad%x09%s',
    ])
    const commits = log.ok
      ? log.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
        const [hash, date, ...rest] = line.split('\t')
        return { hash, date, subject: rest.join('\t') }
      })
      : []
    return { ok: true, git: true, commits, checkpoints: await listCheckpoints(root), error: log.ok ? null : log.stderr }
  })

  ipcMain.handle('ws:rollback', async (_event, payload) => {
    const root = String(payload?.root ?? '')
    const hash = String(payload?.hash ?? '')
    const hard = payload?.hard === true
    if (root === '' || hash === '') return { ok: false, error: '缺少回退目标' }
    await createCheckpoint(root, `回退前自动检查点`)
    const result = hard
      ? await execGit(root, ['reset', '--hard', hash])
      : await execGit(root, ['restore', '--source', hash, '--worktree', '--', '.'])
    return {
      ok: result.ok,
      error: result.ok ? null : (result.stderr || result.error),
      log: (result.stdout + '\n' + result.stderr).trim(),
    }
  })

  ipcMain.handle('ws:checkpoint', async (_event, payload) => {
    const root = String(payload?.root ?? '')
    const label = String(payload?.label ?? '').trim() || `检查点 ${new Date().toLocaleString('zh-CN', { hour12: false })}`
    if (root === '') return { ok: false, error: '未选择工作区' }
    return await createCheckpoint(root, label)
  })

  ipcMain.handle('ws:restore-checkpoint', async (_event, payload) => {
    const root = String(payload?.root ?? '')
    const id = String(payload?.id ?? '')
    const dir = path.join(checkpointRoot(), workspaceKey(root), id)
    if (!existsSync(dir)) return { ok: false, error: '检查点不存在' }
    await createCheckpoint(root, '恢复检查点前自动备份')
    const filesDir = path.join(dir, 'files')
    if (existsSync(filesDir)) {
      await cp(filesDir, root, { recursive: true, force: true })
    }
    return { ok: true }
  })

  function stopTerm() {
    if (term === null) return
    const child = term
    term = null
    try { child.kill() } catch { /* already gone */ }
  }

  ipcMain.handle('term:start', (_event, payload) => {
    const cwd = String(payload?.cwd ?? '')
    stopTerm()
    const shellName = existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe') ? 'pwsh.exe' : 'powershell.exe'
    const child = spawn(shellName, ['-NoLogo'], {
      cwd: cwd && existsSync(cwd) ? cwd : undefined,
      windowsHide: true,
      env: process.env,
    })
    term = child
    child.stdout.on('data', (chunk) => sendToMain('term:data', { text: chunk.toString() }))
    child.stderr.on('data', (chunk) => sendToMain('term:data', { text: chunk.toString() }))
    child.on('close', (code) => {
      if (term === child) term = null
      sendToMain('term:exit', { code })
    })
    return { ok: true, shell: shellName }
  })

  ipcMain.handle('term:write', (_event, payload) => {
    const text = String(payload?.text ?? '')
    if (term === null || term.stdin === null) return { ok: false, error: '终端未启动' }
    term.stdin.write(text)
    return { ok: true }
  })

  ipcMain.handle('term:stop', () => {
    stopTerm()
    return { ok: true }
  })

  async function listCheckpoints(root) {
    if (!root) return []
    const dir = path.join(checkpointRoot(), workspaceKey(root))
    if (!existsSync(dir)) return []
    const names = await readdir(dir, { withFileTypes: true })
    const rows = []
    for (const entry of names) {
      if (!entry.isDirectory()) continue
      try {
        const meta = JSON.parse(await readFile(path.join(dir, entry.name, 'meta.json'), 'utf8'))
        rows.push({ id: entry.name, ...meta })
      } catch {
        rows.push({ id: entry.name, label: entry.name, createdAt: null })
      }
    }
    rows.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    return rows
  }

  async function createCheckpoint(root, label) {
    const id = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = path.join(checkpointRoot(), workspaceKey(root), id)
    await mkdir(path.join(dest, 'files'), { recursive: true })
    const git = existsSync(path.join(root, '.git'))
    let copied = 0
    if (git) {
      const listed = await execGit(root, ['ls-files'])
      const files = listed.ok ? listed.stdout.split(/\r?\n/).filter(Boolean) : []
      for (const rel of files.slice(0, 400)) {
        const src = path.join(root, rel)
        if (!existsSync(src)) continue
        try {
          const info = await stat(src)
          if (!info.isFile() || info.size > 2_000_000) continue
          const out = path.join(dest, 'files', rel)
          await mkdir(path.dirname(out), { recursive: true })
          await cp(src, out)
          copied += 1
        } catch {
          /* skip unreadable */
        }
      }
    }
    await writeFile(path.join(dest, 'meta.json'), JSON.stringify({
      label, createdAt: new Date().toISOString(), fileCount: copied, git,
    }), 'utf8')
    return { ok: true, id, fileCount: copied }
  }

  return { stopTerm }
}
