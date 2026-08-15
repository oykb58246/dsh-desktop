/**
 * Copilot-style file revert: restore workspace files from git HEAD, or
 * delete a just-created file when the path no longer matches HEAD.
 */
import { ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'

function execGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 20_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: error == null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

function resolveInside(root, target) {
  const base = path.resolve(root)
  const full = path.resolve(target)
  const prefix = base.toLowerCase()
  const value = full.toLowerCase()
  return value === prefix || value.startsWith(prefix + path.sep)
}

/** Register revert IPC. `listWorkspaceRoots` returns absolute cwd list. */
export function registerFileRevertIpc(listWorkspaceRoots) {
  ipcMain.handle('dsh:file-revert', async (_event, payload) => {
    const changes = Array.isArray(payload?.changes) ? payload.changes : []
    const roots = (await listWorkspaceRoots()).map((root) => path.resolve(root))
    const results = []
    for (const change of changes.slice(0, 200)) {
      const filePath = String(change?.path ?? '')
      if (filePath === '') {
        results.push({ path: filePath, status: 'invalid' })
        continue
      }
      const abs = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(roots[0] ?? process.cwd(), filePath)
      if (!roots.some((root) => resolveInside(root, abs))) {
        results.push({ path: abs, status: 'forbidden' })
        continue
      }
      const root = roots.find((dir) => resolveInside(dir, abs)) ?? path.dirname(abs)
      try {
        if (existsSync(path.join(root, '.git'))) {
          const rel = path.relative(root, abs).replaceAll('\\', '/')
          const show = await execGit(root, ['show', `HEAD:${rel}`])
          if (show.ok) {
            await writeFile(abs, show.stdout, 'utf8')
            results.push({ path: abs, status: 'reverted' })
            continue
          }
          if (existsSync(abs)) {
            await rm(abs, { force: true })
            results.push({ path: abs, status: 'reverted' })
            continue
          }
        }
        if (typeof change.oldText === 'string' && change.oldText !== '') {
          const current = existsSync(abs) ? await readFile(abs, 'utf8') : null
          if (current === change.newText || current === null) {
            await writeFile(abs, change.oldText, 'utf8')
            results.push({ path: abs, status: 'reverted' })
          } else {
            results.push({ path: abs, status: 'conflict' })
          }
          continue
        }
        results.push({ path: abs, status: 'missing' })
      } catch (error) {
        results.push({ path: abs, status: 'failed', error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { results }
  })
}
