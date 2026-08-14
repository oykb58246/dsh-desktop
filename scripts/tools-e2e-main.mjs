// Throwaway E2E driver: boots tools.html with the real preload/tools.js, but
// serves the codex-import-* handlers from a test fake, so the cockpit-style
// auto-scan + tick + one-shot-import chain runs without touching real data.
// NOT part of the product.
import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'

const desktopRoot = path.resolve(import.meta.dirname, '..')
let customRoot = null

const FAKE_PROJECTS = [
  {
    name: 'demo-app',
    cwd: 'D:\\fake\\codex-workspace\\demo-app',
    shallow: false,
    sessions: [
      { id: 's1', title: '实现登录页', cwd: 'D:\\fake\\codex-workspace\\demo-app', file: 'D:\\fake\\s1.jsonl', startedAt: '2026-08-01T08:00:00.000Z', model: 'codex' },
      { id: 's2', title: '修复样式问题', cwd: 'D:\\fake\\codex-workspace\\demo-app', file: 'D:\\fake\\s2.jsonl', startedAt: '2026-08-02T09:00:00.000Z', model: 'codex' },
    ],
  },
  {
    name: 'library-core',
    cwd: 'D:\\fake\\codex-workspace\\library-core',
    shallow: false,
    sessions: [
      { id: 's3', title: '设计 API', cwd: 'D:\\fake\\codex-workspace\\library-core', file: 'D:\\fake\\s3.jsonl', startedAt: '2026-08-03T10:00:00.000Z', model: 'codex' },
    ],
  },
  {
    name: '17367',
    cwd: 'C:\\Users\\17367',
    shallow: true,
    sessions: [
      { id: 's4', title: '零散操作', cwd: 'C:\\Users\\17367', file: 'D:\\fake\\s4.jsonl', startedAt: '2026-07-01T11:00:00.000Z', model: 'codex' },
    ],
  },
]

ipcMain.handle('codex-import-get-config', () => ({
  sessions: {
    customRoot,
    defaultRoot: path.join(desktopRoot, 'output', 'fake-default-sessions'),
    effectiveRoot: customRoot ?? path.join(desktopRoot, 'output', 'fake-default-sessions'),
  },
  targetRoot: path.join(desktopRoot, 'output', 'fake-harness-projects'),
}))
ipcMain.handle('codex-import-scan-all', () => {
  const projects = FAKE_PROJECTS.map((p) => ({
    ...p,
    sessions: p.sessions.map((s) => ({ ...s, imported: s.id === 's2' })),
  }))
  return { sessionsRoot: 'fake', projects, importedCount: 1 }
})
ipcMain.handle('codex-sessions-choose', () => {
  customRoot = 'D:\\custom-test-sessions'
  return {
    sessions: {
      customRoot,
      defaultRoot: path.join(desktopRoot, 'output', 'fake-default-sessions'),
      effectiveRoot: customRoot,
    },
    targetRoot: path.join(desktopRoot, 'output', 'fake-harness-projects'),
  }
})
ipcMain.handle('codex-sessions-reset', () => {
  customRoot = null
  return {
    sessions: {
      customRoot: null,
      defaultRoot: path.join(desktopRoot, 'output', 'fake-default-sessions'),
      effectiveRoot: path.join(desktopRoot, 'output', 'fake-default-sessions'),
    },
    targetRoot: path.join(desktopRoot, 'output', 'fake-harness-projects'),
  }
})
ipcMain.handle('codex-import-choose-target', () => ({
  sessions: {
    customRoot,
    defaultRoot: path.join(desktopRoot, 'output', 'fake-default-sessions'),
    effectiveRoot: customRoot ?? path.join(desktopRoot, 'output', 'fake-default-sessions'),
  },
  targetRoot: 'D:\\custom-target-projects',
}))
ipcMain.handle('codex-import-run', async (_event, { selection }) => {
  return selection.map((item) => ({
    name: item.name,
    targetPath: item.shallow ? item.cwd : `D:\\target\\${item.name}`,
    copy: item.shallow
      ? null
      : { name: item.name, targetPath: `D:\\target\\${item.name}`, files: 42 },
    written: item.rollouts.map((r) => ({ sessionId: r.id, cwd: `D:\\target\\${item.name}`, logPath: `D:\\target\\${item.name}\\${r.id}.zstd`, events: 3 })),
    skipped: [],
    workspace: item.shallow ? null : { ok: true, workspace: { path: `D:\\target\\${item.name}` }, created: true },
  }))
})

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1040,
    height: 740,
    show: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, '..', 'electron', 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  void win.loadFile(path.join(import.meta.dirname, '..', 'electron', 'tools.html'))
  console.log('TOOLS_E2E_READY')
})
