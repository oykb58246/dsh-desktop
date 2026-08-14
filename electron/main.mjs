import { app, BrowserWindow, Menu, shell, ipcMain, screen, dialog } from 'electron'
import { existsSync, readFileSync, appendFileSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { scanCodexProjects } from './codex-projects.mjs'
import { createRequire } from 'node:module'
// original-fs bypasses Electron's asar virtual-fs patch; the install worker
// must copy resources/app.asar as a plain file.
const require2 = createRequire(import.meta.url)
const originalFs = require2('original-fs')
import {
  copyProjects,
  decodeSegment,
  importSessionFromRollout,
  precheckImport,
  readSessionLogCwd,
  scanAllCodexSessions,
  defaultCodexSessionsRoot,
} from './codex-import.mjs'
import { registerUpdateIpc, runBackgroundCheck } from './updater.mjs'

const desktopRoot = path.resolve(import.meta.dirname, '..')
const harnessRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'dsh-runtime')
  : path.join(desktopRoot, 'deepseek-harness')
const harnessEntry = app.isPackaged
  ? path.join(harnessRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  : path.join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
// Windows taskbar entries require an ICO. This file is derived from the
// user-selected website/assets/favicon.svg and is only the native counterpart.
// Packaged files live INSIDE app.asar, so the path must go through the .asar
// segment (resources/app/... does not exist on disk).
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar', 'assets', 'icon.ico')
  : path.join(desktopRoot, 'assets', 'icon.ico')
const appLogoPath = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar', 'website', 'assets', 'favicon.svg')
  : path.join(desktopRoot, 'website', 'assets', 'favicon.svg')
const isWindows = process.platform === 'win32'
const statusText = {
  start: 'Starting deepseek-harness',
  startDetail: 'Preparing local dsh web service',
  logs: 'deepseek-harness logs',
  failed: 'Startup failed',
}

let mainWindow = null
let toolsWindow = null
let harnessProcess = null
let harnessUrl = null
let stopping = false
let loadingWindow = true

const dshHomeDir = path.join(app.getPath('userData'), 'dsh-home')

/** Bundled kernel version: the packaged @deepseek-ai/dsh runtime, or the
 * upstream.lock.json pin / workspace version in dev. */
function kernelBundledVersion() {
  const candidates = [
    path.join(harnessRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    path.join(desktopRoot, 'upstream.lock.json'),
    path.join(desktopRoot, 'deepseek-harness', 'package.json'),
  ]
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed?.kernel?.version === 'string') return parsed.kernel.version
      if (typeof parsed?.version === 'string') return parsed.version
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

/**
 * Import configuration: the user-chosen Codex sessions root (null = auto
 * detect) and the Harness target directory receiving copied projects
 * (null = default `~/Documents/DSH-Harness-Projects`). Persisted as JSON
 * under the user data directory.
 */
const codexImportConfigPath = path.join(app.getPath('userData'), 'codex-import-config.json')
let codexSessionsCustomRoot = null
let codexImportTargetRoot = null

/** Default Harness target root for copied projects. */
function defaultTargetRoot() {
  return path.join(app.getPath('documents'), 'DSH-Harness-Projects')
}

/** Load the persisted import configuration (best-effort). */
async function loadCodexImportConfig() {
  try {
    const parsed = JSON.parse(await readFile(codexImportConfigPath, 'utf8'))
    if (typeof parsed?.customSessionsRoot === 'string' && parsed.customSessionsRoot.trim() !== '') {
      codexSessionsCustomRoot = parsed.customSessionsRoot.trim()
    }
    if (typeof parsed?.targetRoot === 'string' && parsed.targetRoot.trim() !== '') {
      codexImportTargetRoot = parsed.targetRoot.trim()
    }
  } catch {
    codexSessionsCustomRoot = null
    codexImportTargetRoot = null
  }
}

/** Persist the import configuration (or remove the file when fully default). */
async function saveCodexImportConfig() {
  if (codexSessionsCustomRoot === null && codexImportTargetRoot === null) {
    try {
      await (await import('node:fs/promises')).rm(codexImportConfigPath, { force: true })
    } catch {
      // Removal is best-effort; an unreadable stale file simply falls back.
    }
    return
  }
  await mkdir(path.dirname(codexImportConfigPath), { recursive: true })
  await writeFile(codexImportConfigPath, JSON.stringify({
    ...(codexSessionsCustomRoot !== null ? { customSessionsRoot: codexSessionsCustomRoot } : {}),
    ...(codexImportTargetRoot !== null ? { targetRoot: codexImportTargetRoot } : {}),
  }, null, 2))
}

/** The current import-config snapshot for the tools window. */
function codexImportConfigView() {
  return {
    sessions: {
      customRoot: codexSessionsCustomRoot,
      defaultRoot: defaultCodexSessionsRoot(),
      effectiveRoot: codexSessionsCustomRoot ?? defaultCodexSessionsRoot(),
    },
    targetRoot: codexImportTargetRoot ?? defaultTargetRoot(),
  }
}

app.setAppUserModelId('com.oykb58246.dsh-desktop')

// ---------- installer constants & modes ----------
const APP_GUID = '2964e23e-3f18-500c-b3e7-68e9fa24df7a'
const APP_VERSION = '0.1.0'
const UNINSTALL_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + APP_GUID
const INI_PATH = 'C:\\dsh-desktop.ini'
const INSTALL_LOG = 'C:\\dsh-desktop-install.log'
const isInstallerWorker = process.argv.includes('--installer-worker')
const isUninstall = process.argv.includes('--uninstall')
const isUninstallWorker = process.argv.includes('--uninstall-worker')

let startupLogPath = null
function startupLog(line) {
  try {
    if (startupLogPath === null) {
      startupLogPath = path.join(app.getPath('userData'), 'logs', 'startup.log')
            mkdirSync(path.dirname(startupLogPath), { recursive: true })
    }
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
        appendFileSync(startupLogPath, `${stamp} ${String(line)}\n`, 'utf8')
  } catch {
    /* logging must never break the app */
  }
}

function logLineSink(logPath) {
  let handle = null
  return {
    open() {
      try { handle = openSync(logPath, 'w') } catch { handle = null }
    },
    write(kind, text) {
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
      const line = `${stamp} | ${kind} | ${text}\n`
      if (handle !== null) {
                try { writeSync(handle, line, null, 'utf8') } catch { /* ignore */ }
      }
    },
    close() {
      if (handle !== null) {
                try { closeSync(handle) } catch { /* ignore */ }
        handle = null
      }
    },
  }
}

function sendStatus(headline, message = headline) {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('status', { headline, message })
}

function createWindow() {
  Menu.setApplicationMenu(null)
  mainWindow = new BrowserWindow({
    width: 430,
    height: 300,
    backgroundColor: '#0d1726',
    frame: false,
    transparent: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    icon: appIconPath,
    title: 'DSH Desktop',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.once('ready-to-show', () => {
    startupLog('main window ready-to-show')
    mainWindow?.show()
  })
  void mainWindow.loadFile(path.join(import.meta.dirname, 'loading.html'))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

function expandMainWindow() {
  if (mainWindow === null || mainWindow.isDestroyed() || !loadingWindow) return
  loadingWindow = false
  mainWindow.setSkipTaskbar(false)
  const display = screen.getDisplayMatching(mainWindow.getBounds())
  const area = display.workArea
  const target = {
    x: area.x + Math.max(0, Math.round((area.width - 1440) / 2)),
    y: area.y + Math.max(0, Math.round((area.height - 960) / 2)),
    width: Math.min(1440, area.width),
    height: Math.min(960, area.height),
  }
  const start = mainWindow.getBounds()
  const duration = 460
  const startedAt = Date.now()
  startupLog(`expand: ${start.width}x${start.height} -> ${target.width}x${target.height}`)
  mainWindow.setResizable(true)
  const tick = () => {
    if (mainWindow === null || mainWindow.isDestroyed()) return
    const progress = Math.min(1, (Date.now() - startedAt) / duration)
    const eased = 1 - Math.pow(1 - progress, 3)
    mainWindow.setBounds({
      x: Math.round(start.x + (target.x - start.x) * eased),
      y: Math.round(start.y + (target.y - start.y) * eased),
      width: Math.round(start.width + (target.width - start.width) * eased),
      height: Math.round(start.height + (target.height - start.height) * eased),
    })
    if (progress < 1) {
      setTimeout(tick, 16)
    } else {
      // Keep the minimum size inside the target so small work areas never
      // force the window larger than the screen.
      mainWindow.setMinimumSize(Math.min(1120, target.width), Math.min(760, target.height))
      startupLog('expand done; visible=' + mainWindow.isVisible() + ' minimized=' + mainWindow.isMinimized())
    }
  }
  tick()
}

ipcMain.on('window-action', (event, action) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (window === null || window.isDestroyed()) return
  if (action === 'tools') {
    openToolsWindow()
    return
  }
  if (action === 'minimize') window.minimize()
  if (action === 'maximize') {
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  }
  if (action === 'close') {
    const closingTools = window === toolsWindow
    window.close()
    // Closing the tools window returns focus to the main harness window.
    if (closingTools && mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  }
})

/**
 * Open (or focus) the standalone tools workbench window. Frameless, loads the
 * local tools.html through the same preload bridge; its own title bar
 * drives window actions through the shared channel.
 */
function openToolsWindow() {
  if (toolsWindow !== null && !toolsWindow.isDestroyed()) {
    if (toolsWindow.isMinimized()) toolsWindow.restore()
    toolsWindow.show()
    toolsWindow.focus()
    return
  }
  toolsWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#0f1520',
    frame: false,
    show: false,
    icon: appIconPath,
    title: 'DSH Desktop 工具区',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  toolsWindow.on('closed', () => {
    toolsWindow = null
  })
  toolsWindow.once('ready-to-show', () => toolsWindow?.show())
  void toolsWindow.loadFile(path.join(import.meta.dirname, 'tools.html'))
}

/** Forward a codex-import progress event to the tools window, when open. */
function sendToolsProgress(payload) {
  if (toolsWindow === null || toolsWindow.isDestroyed()) return
  toolsWindow.webContents.send('codex-import-progress', payload)
}

/**
 * Show a directory picker owned by the tools window and restore the tools
 * window's z-order afterwards. Without the restore, the modal dialog leaves
 * the frameless tools window buried behind the main window on Windows.
 * @param title - dialog title.
 * @returns the picked path, or null when cancelled.
 */
async function pickToolsDirectory(title) {
  const owner = toolsWindow ?? mainWindow
  if (owner === null || owner.isDestroyed()) return null
  const result = await dialog.showOpenDialog(owner, {
    title,
    buttonLabel: '选择此目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (toolsWindow !== null && !toolsWindow.isDestroyed()) {
    toolsWindow.show()
    toolsWindow.focus()
  }
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

ipcMain.handle('codex-project-choose-source', async () => {
  const picked = await pickToolsDirectory('选择 Codex 工作区')
  if (picked === null) return null
  return await scanCodexProjects(picked)
})

ipcMain.handle('codex-project-scan-source', async (_event, rootPath) => {
  return await scanCodexProjects(rootPath)
})

/** Read the current import configuration (sessions root + target root). */
ipcMain.handle('codex-import-get-config', async () => {
  return codexImportConfigView()
})

/** Scan the effective sessions root and aggregate projects + rollouts. */
ipcMain.handle('codex-import-scan-all', async () => {
  const scan = await scanAllCodexSessions(codexSessionsCustomRoot)
  const imported = await listImportedSessions()
  let importedCount = 0
  for (const project of scan.projects) {
    for (const session of project.sessions) {
      session.imported = imported.has(session.id)
      if (session.imported) importedCount += 1
    }
  }
  scan.importedCount = importedCount
  // Best-effort: re-attach previously imported sessions whose workspace
  // grouping was lost (e.g. an older import predating workspace attachment).
  const titleById = new Map()
  for (const project of scan.projects) {
    for (const session of project.sessions) {
      if (typeof session.title === 'string' && session.title.trim() !== '') {
        titleById.set(session.id, session.title.trim())
      }
    }
  }
  await repairUngroupedSessions(imported, titleById)
  return scan
})

/**
 * Collect the sessions already present under DSH_HOME/sessions: id (decoded
 * from the directory name) plus the log header's cwd, which drives workspace
 * re-grouping.
 * @returns a Map of raw session id → stored cwd.
 */
async function listImportedSessions() {
  const imported = new Map()
  const root = path.join(dshHomeDir, 'sessions')
  let projectDirs
  try {
    projectDirs = await readdir(root, { withFileTypes: true })
  } catch {
    return imported
  }
  for (const project of projectDirs) {
    if (!project.isDirectory()) continue
    let sessionDirs
    try {
      sessionDirs = await readdir(path.join(root, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessionDirs) {
      if (!session.isDirectory()) continue
      const id = decodeSegment(session.name)
      if (id === null) continue
      const artifact = path.join(root, project.name, session.name, 'session.jsonl.zstd')
      const cwd = await readSessionLogCwd(artifact)
      imported.set(id, cwd)
    }
  }
  return imported
}

/**
 * Re-attach imported sessions that exist on disk but are not listed in any
 * workspace (the sidebar shows them as 未分组). A workspace whose path equals
 * the session's stored cwd — or contains it — receives the session; when no
 * such workspace exists one is recreated from the session cwd so previously
 * imported sessions never stay orphaned. No-op while the harness web service
 * is unavailable.
 * @param imported - Map of session id → stored cwd.
 * @param titleById - Map of session id → Codex thread name (pinned as title).
 */
async function repairUngroupedSessions(imported, titleById) {
  if (harnessUrl === null || imported.size === 0) return
  const callRpc = async (method, payload) => {
    const response = await fetch(`${harnessUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method,
        payload,
      }),
    })
    return await response.json()
  }
  let workspaces
  try {
    const listResult = await callRpc('workspace.list', {})
    if (listResult?.result?.ok !== true) return
    workspaces = listResult.result.value?.items ?? []
  } catch {
    return
  }
  const attached = new Set(workspaces.flatMap((w) => w.sessionIds ?? []))
  for (const [id, cwd] of imported) {
    if (cwd === null) continue
    let workspace = workspaces.find((w) => w.path === cwd)
    try {
      if (workspace === undefined) {
        // Recreate the workspace from the session's stored cwd (fails cleanly
        // when the directory no longer exists).
        const createResult = await callRpc('workspace.create', { path: cwd })
        if (createResult?.result?.ok !== true) continue
        workspace = createResult.result.value?.workspace ?? null
        if (workspace !== null) workspaces.push(workspace)
      }
      if (workspace === null) continue
      if (!attached.has(id)) {
        // session.create with an explicit id RESUMES the stored log (same id,
        // same cwd) and attaches it to the workspace.
        await callRpc('session.create', { workspaceId: workspace.workspaceId, sessionId: id })
        attached.add(id)
      }
      const title = titleById?.get(id) ?? ''
      if (title.trim() !== '') {
        await callRpc('session.rename', { sessionId: id, title: title.trim().slice(0, 120) })
      }
    } catch {
      // Repair is best-effort; the next scan retries.
    }
  }
}

/** Pick a custom Codex sessions directory and persist it. */
ipcMain.handle('codex-sessions-choose', async () => {
  const picked = await pickToolsDirectory('选择 Codex 会话目录')
  if (picked === null) return null
  codexSessionsCustomRoot = picked
  await saveCodexImportConfig()
  return codexImportConfigView()
})

/** Reset the sessions directory back to the auto-detected default. */
ipcMain.handle('codex-sessions-reset', async () => {
  codexSessionsCustomRoot = null
  await saveCodexImportConfig()
  return codexImportConfigView()
})

/** Choose (and persist) the Harness target directory for copied projects. */
ipcMain.handle('codex-import-choose-target', async () => {
  const picked = await pickToolsDirectory('选择 Harness 项目目录')
  if (picked === null) return null
  codexImportTargetRoot = picked
  await saveCodexImportConfig()
  return codexImportConfigView()
})

/**
 * One-shot import: copy the chosen projects into the target root, convert the
 * chosen Codex rollouts into dsh session logs, and register each copied
 * directory as a dsh workspace. Streams progress; resolves with per-project
 * results.
 */
ipcMain.handle('codex-import-run', async (_event, { selection }) => {
  const targetRoot = codexImportTargetRoot ?? defaultTargetRoot()
  // Distinct cwds may share a basename (e.g. nested `src-tauri`); give each a
  // unique target directory name so copies never collide.
  const usedNames = new Map()
  const uniqueSelection = selection.map((item) => {
    const base = item.name || 'project'
    let name = base
    let suffix = 2
    while (usedNames.has(name)) {
      name = `${base}-${suffix}`
      suffix += 1
    }
    usedNames.set(name, true)
    return { ...item, name }
  })

  const results = []
  for (const item of uniqueSelection) {
    const targetPath = path.join(targetRoot, item.name)
    // Shallow groups (drive roots, the user profile, aggregate folders) are
    // session-only: never copy the whole directory; sessions keep their
    // original cwd and no workspace is registered.
    let copy = null
    if (!item.shallow) {
      try {
        const [copyResult] = await copyProjects(targetRoot, [{ name: item.name, absolutePath: item.cwd }], (progress) => {
          sendToolsProgress({ kind: 'copy-progress', ...progress })
        })
        copy = copyResult
      } catch (error) {
        copy = { name: item.name, targetPath, files: 0, error: error instanceof Error ? error.message : String(error) }
      }
    }
    sendToolsProgress({ kind: 'copy-done', project: item.name, files: copy?.files ?? 0 })

    const sessionCwd = copy !== null ? targetPath : item.cwd
    const written = []
    const skipped = []
    for (const rollout of item.rollouts) {
      try {
        const outcome = await importSessionFromRollout({
          rollout: rollout.file,
          cwd: sessionCwd,
          sessionId: rollout.id || undefined,
          dshHome: dshHomeDir,
          onEvent: (event) => sendToolsProgress({ kind: 'session-progress', phase: event.kind, project: item.name, ...event }),
        })
        written.push(outcome)
      } catch (error) {
        skipped.push({ id: rollout.id ?? rollout.file, error: error instanceof Error ? error.message : String(error) })
      }
    }

    let workspace = null
    if (harnessUrl !== null && copy !== null && copy.error === undefined) {
      try {
        const createBody = {
          type: 'client-request',
          rpcId: randomUUID(),
          method: 'workspace.create',
          payload: { path: targetPath },
        }
        const createResponse = await fetch(`${harnessUrl}/api/workspace.create`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(createBody),
        })
        const createJson = await createResponse.json()
        const createResult = createJson?.result
        if (createResult?.ok !== true) {
          workspace = { ok: false, error: createResult?.error?.message ?? `注册失败 (HTTP ${createResponse.status})` }
        } else {
          const workspaceId = createResult.value?.workspace?.workspaceId
          // Attach each freshly written session to the workspace via
          // session.create: the harness finds the stored log (same id, same
          // cwd) and RESUMES it instead of overwriting, then attaches it to
          // the workspace so the sidebar groups it under the project.
          let attached = 0
          if (workspaceId !== undefined) {
            for (const outcome of written) {
              try {
                const attachBody = {
                  type: 'client-request',
                  rpcId: randomUUID(),
                  method: 'session.create',
                  payload: { workspaceId, sessionId: outcome.sessionId },
                }
                const attachResponse = await fetch(`${harnessUrl}/api/session.create`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(attachBody),
                })
                const attachJson = await attachResponse.json()
                if (attachJson?.result?.ok === true) attached += 1
              } catch {
                // Attachment is best-effort; the session log is already valid.
              }
              // Pin the Codex session name as the dsh session title so the
              // sidebar shows the thread name, not the project/fallback label.
              const title = item.rollouts.find((r) => (r.id ?? r.file) === outcome.sessionId)?.title ?? ''
              if (title.trim() !== '') {
                try {
                  const renameBody = {
                    type: 'client-request',
                    rpcId: randomUUID(),
                    method: 'session.rename',
                    payload: { sessionId: outcome.sessionId, title: title.trim().slice(0, 120) },
                  }
                  await fetch(`${harnessUrl}/api/session.rename`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(renameBody),
                  })
                } catch {
                  // Title pinning is best-effort; the fallback title remains.
                }
              }
            }
          }
          workspace = {
            ok: true,
            workspace: createResult.value?.workspace ?? null,
            created: createResult.value?.created ?? false,
            attached,
          }
        }
      } catch (error) {
        workspace = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    results.push({ name: item.name, targetPath, copy, written, skipped, workspace })
  }
  return results
})

async function injectWindowChrome() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  const iconSvg = readFileSync(appLogoPath).toString('base64')
  const iconUrl = `data:image/svg+xml;base64,${iconSvg}`
  await mainWindow.webContents.executeJavaScript(`(() => {
    if (document.getElementById('dsh-window-chrome')) return;
    const bar = document.createElement('div');
    bar.id = 'dsh-window-chrome';
    bar.innerHTML = '<img class="dsh-window-icon" src="${iconUrl}"/><span class="dsh-window-title">DSH Desktop</span><div class="dsh-window-actions"><button class="dsh-title-button dsh-tools" data-action="tools" aria-label="工具区" title="工具区"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4.5 4.5 0 0 0-6.1 5.4L3 17.3V21h3.7l5.6-5.6a4.5 4.5 0 0 0 5.4-6.1l-3.2 3.2-2.8-.7-.7-2.8 3.7-3.7z"/></svg></button><button class="dsh-title-button dsh-minimize" data-action="minimize" aria-label="Minimize"></button><button class="dsh-title-button dsh-maximize" data-action="maximize" aria-label="Maximize"></button><button class="dsh-title-button dsh-close" data-action="close" aria-label="Close"></button></div>';
    const style = document.createElement('style');
    style.textContent = \`
      #dsh-window-chrome { position: fixed; inset: 0 0 auto 0; height: 42px; z-index: 2147483647; display:flex; align-items:center; gap:10px; padding:0 10px 0 14px; color:#eef3ff; background:#171d2a; border-bottom:1px solid rgba(255,255,255,.08); font:600 13px "Segoe UI", "Microsoft YaHei", sans-serif; -webkit-app-region:drag; user-select:none; }
      #dsh-window-chrome .dsh-window-icon { width:25px; height:25px; object-fit:contain; }
      #dsh-window-chrome .dsh-window-title { letter-spacing:.02em; }
      #dsh-window-chrome .dsh-window-actions { margin-left:auto; display:flex; height:100%; -webkit-app-region:no-drag; }
      #dsh-window-chrome .dsh-title-button { position:relative; width:46px; border:0; background:transparent; color:inherit; cursor:pointer; opacity:.86; }
      #dsh-window-chrome .dsh-title-button::before, #dsh-window-chrome .dsh-title-button::after { content:""; position:absolute; left:50%; top:50%; width:12px; height:1.5px; background:currentColor; transform:translate(-50%,-50%); }
      #dsh-window-chrome .dsh-maximize::before { width:9px; height:9px; border:1.5px solid currentColor; background:transparent; }
      #dsh-window-chrome .dsh-maximize::after { display:none; }
      #dsh-window-chrome .dsh-close::before { transform:translate(-50%,-50%) rotate(45deg); }
      #dsh-window-chrome .dsh-close::after { transform:translate(-50%,-50%) rotate(-45deg); }
      #dsh-window-chrome .dsh-tools::before, #dsh-window-chrome .dsh-tools::after { display:none; }
      #dsh-window-chrome .dsh-tools svg { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); }
      #dsh-window-chrome .dsh-tools.has-update::after { display:block; content:""; position:absolute; top:7px; right:8px; width:8px; height:8px; border-radius:50%; background:#4d8bfd; box-shadow:0 0 8px rgba(77,139,253,.95); }
      #dsh-window-chrome button:hover { background:rgba(255,255,255,.10); opacity:1; }
      #dsh-window-chrome button[data-action="close"]:hover { background:#d94b5b; }
      html.dsh-light #dsh-window-chrome { color:#17212b; background:#f7f9fc; border-bottom-color:rgba(23,33,43,.12); }
      html.dsh-light #dsh-window-chrome button:hover { background:rgba(23,33,43,.08); }
      html.dsh-light #dsh-window-chrome button[data-action="close"]:hover { color:white; background:#d94b5b; }
      html { height:100% !important; overflow:hidden !important; overscroll-behavior:none; }
      body { height:100% !important; max-height:100% !important; box-sizing:border-box !important; overflow:hidden !important; padding-top:42px !important; }
    \`;
    document.head.appendChild(style); document.body.appendChild(bar);
    const updateTheme = () => { const scheme = getComputedStyle(document.documentElement).colorScheme; const dark = document.body.hasAttribute('data-ds-dark-theme') || scheme.includes('dark'); document.documentElement.classList.toggle('dsh-light', !dark); };
    updateTheme(); new MutationObserver(updateTheme).observe(document.documentElement, {attributes:true, attributeFilter:['class','data-theme','style']}); new MutationObserver(updateTheme).observe(document.body, {attributes:true, attributeFilter:['class','data-theme','data-ds-dark-theme','style']});
    bar.querySelectorAll('button').forEach(button => button.addEventListener('click', () => window.dshDesktop.windowAction(button.dataset.action)));
    if (window.dshDesktop && typeof window.dshDesktop.onUpdateAvailable === 'function') { window.dshDesktop.onUpdateAvailable(() => { const tools = bar.querySelector('.dsh-tools'); if (tools) tools.classList.add('has-update'); }); }
  })()`)
}

async function ensureHarnessReady() {
  if (!existsSync(harnessRoot)) {
    throw new Error(`Missing packaged deepseek-harness runtime at ${harnessRoot}`)
  }
  if (!existsSync(harnessEntry)) {
    throw new Error(`Missing deepseek-harness CLI entry at ${harnessEntry}`)
  }
  if (app.isPackaged && !existsSync(path.join(harnessRoot, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'))) {
    throw new Error('Missing packaged deepseek-harness web assets')
  }
}

function stopHarnessProcess() {
  if (harnessProcess === null || harnessProcess.killed) return Promise.resolve()

  const child = harnessProcess
  harnessProcess = null

  return new Promise((resolve) => {
    child.once('exit', () => resolve())

    if (isWindows) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
      })
      killer.once('close', () => resolve())
      return
    }

    child.kill('SIGTERM')
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL')
    }, 4_000).unref()
  })
}

async function launchHarness() {
  const dshHome = path.join(app.getPath('userData'), 'dsh-home')
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
  }

  sendStatus(statusText.start, statusText.startDetail)

  await new Promise((resolve, reject) => {
    const child = spawn(
      app.isPackaged ? process.execPath : 'node',
      [harnessEntry, 'web', '--host', '127.0.0.1', '--port', '0'],
      {
        cwd: harnessRoot,
        env: app.isPackaged ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    harnessProcess = child
    createWindow()
    let settled = false
    let output = ''
    let stdoutBuffer = ''
    let stderrBuffer = ''

    const finishStartup = (harnessUrlValue) => {
      if (settled || mainWindow === null || mainWindow.isDestroyed()) return
      settled = true
      harnessUrl = harnessUrlValue
      void mainWindow.loadURL(harnessUrlValue).then(async () => {
        try {
          await injectWindowChrome()
        } catch (error) {
          // Window chrome is cosmetic; a failure must never block the window
          // from expanding and regaining its taskbar presence.
          startupLog('window chrome inject failed: ' + String(error))
        }
        expandMainWindow()
        resolve()
      }, reject)
    }

    const onLine = (headline, line) => {
      if (line.trim() === '') return
      output += `${line}\n`
      sendStatus(headline, line)
      startupLog('harness: ' + line)
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(line)
      if (match) finishStartup(match[1])
    }
    const consumeChunk = (headline, chunk, isStdout) => {
      const next = `${isStdout ? stdoutBuffer : stderrBuffer}${chunk.toString()}`
      const lines = next.split(/\r?\n/u)
      const remainder = lines.pop() ?? ''
      if (isStdout) stdoutBuffer = remainder
      else stderrBuffer = remainder
      for (const line of lines) onLine(headline, line)
    }

    child.stdout.on('data', (chunk) => {
      consumeChunk(statusText.start, chunk, true)
    })

    child.stderr.on('data', (chunk) => {
      consumeChunk(statusText.logs, chunk, false)
    })

    child.once('error', (error) => {
      if (!settled) reject(error)
    })

    child.once('close', (code) => {
      if (!settled && !stopping) {
        reject(new Error(`dsh web exited early with code ${String(code)}.\n${output}`))
      }
    })

    setTimeout(() => {
      if (!settled && !stopping) {
        reject(new Error(`Timed out waiting for deepseek-harness to finish loading.\n${output}`))
      }
    }, 120_000).unref()
  })
}

async function boot() {
  try {
    startupLog('boot: packaged=' + app.isPackaged + ' exe=' + process.execPath)
    await loadCodexImportConfig()
    await ensureHarnessReady()
    await launchHarness()
    // Non-blocking: compare against the official repository baseline so the
    // title-bar wrench can flag available updates.
    void runBackgroundCheck().then((snapshot) => {
      if (snapshot?.updateAvailable === true && mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:available', snapshot)
      }
    }).catch(() => {})
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    startupLog('boot failed: ' + message)
    if (mainWindow === null) createWindow()
    sendStatus(statusText.failed, message)
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      void mainWindow.loadFile(path.join(import.meta.dirname, 'loading.html'))
      mainWindow.webContents.once('did-finish-load', () => {
        sendStatus(statusText.failed, message)
      })
    }
  }
}

// ==================== installer ====================

function isInstalledHere() {
  try {
        const out = execFileSync('reg', ['query', UNINSTALL_KEY, '/v', 'InstallLocation'], { encoding: 'utf8', windowsHide: true })
    const match = /REG_SZ\s+(.+)$/m.exec(out)
    if (match === null) return false
    const location = match[1].trim()
    const here = path.resolve(process.execPath)
    return here.toLowerCase().startsWith(location.toLowerCase().replace(/[\/]+$/, '') + '\\')
  } catch {
    return false
  }
}

function readIniInstallPath() {
  try {
    const raw = readFileSync(INI_PATH, 'utf8')
    const match = /InstallPath=(.+)$/m.exec(raw)
    if (match) return match[1].trim()
  } catch {
    /* not installed before */
  }
  return path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'DSH Desktop')
}

function runPowershell(command) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || stdout || error)))
        else resolve(String(stdout))
      },
    )
  })
}

async function runInstallerWorker() {
  const targetIndex = process.argv.indexOf('--installer-worker')
  const targetDir = process.argv[targetIndex + 1]
  if (targetDir === undefined) throw new Error('--installer-worker requires a target directory')
  const sourceDir = path.dirname(process.execPath)
  const log = logLineSink(INSTALL_LOG)
  log.open('w')
  const write = (kind, text) => {
    log.write(kind, text)
    startupLog(`worker: ${kind} ${text}`)
  }
  try {
    write('phase', `install started; source=${sourceDir} target=${targetDir}`)
    await copyTreeWithProgress(sourceDir, targetDir, write)
    write('phase', 'files copied; creating shortcuts')
    await createShortcuts(targetDir, write)
    write('phase', 'registering application')
    await writeRegistry(targetDir, write)
    await originalFs.promises.writeFile(INI_PATH, `[DSH Desktop]\r\nInstallPath=${targetDir}\r\n`, 'utf8')
    write('phase', 'install complete')
    if (process.argv.includes('--relaunch')) {
      // Launched by the updater: relaunch the freshly updated install with
      // the user's normal (non-elevated) token via explorer.exe.
      const installedExe = path.join(targetDir, 'DSH Desktop.exe')
      try {
        const child = spawn('explorer.exe', [installedExe], { detached: true, stdio: 'ignore' })
        child.unref()
        write('phase', `relaunch requested: ${installedExe}`)
      } catch (relaunchError) {
        write('error', `relaunch failed: ${String(relaunchError)}`)
      }
    }
  } catch (error) {
    write('error', String(error))
    log.close()
    app.exit(1)
    return
  }
  log.close()
  app.exit(0)
}

async function copyTreeWithProgress(sourceDir, targetDir, write) {
  const files = []
  async function walk(dir, prefix) {
    for (const entry of await originalFs.promises.readdir(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, rel + '\\')
      } else if (entry.isFile()) {
        const stat = await originalFs.promises.stat(full)
        files.push({ rel, full, size: stat.size })
      }
    }
  }
  await walk(sourceDir, '')
  const total = files.reduce((sum, f) => sum + f.size, 0)
  let copied = 0
  let lastPercent = -1
  let count = 0
  for (const file of files) {
    const dest = path.join(targetDir, file.rel)
    await originalFs.promises.mkdir(path.dirname(dest), { recursive: true })
    // During an update the previous app instance may still be shutting down
    // and holding its files; retry locked files for a bounded window.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await originalFs.promises.copyFile(file.full, dest)
        break
      } catch (error) {
        const busy = error !== null && (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES')
        if (busy && attempt < 40) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          continue
        }
        throw error
      }
    }
    copied += file.size
    count += 1
    const percent = total > 0 ? Math.floor((copied * 100) / total) : 100
    write('file', file.rel)
    if (percent !== lastPercent) {
      lastPercent = percent
      write('progress', `${percent}% (${count} files)`)
    }
  }
  write('progress', '100%')
}

async function createShortcuts(targetDir, write) {
  const exe = path.join(targetDir, 'DSH Desktop.exe')
  const desktopLink = 'C:\\Users\\Public\\Desktop\\DSH Desktop.lnk'
  const menuLink = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\DSH Desktop.lnk'
  const ps = `$ws = New-Object -ComObject WScript.Shell;`
    + ` foreach ($p in @('${desktopLink}', '${menuLink}')) {`
    + ` $s = $ws.CreateShortcut($p); $s.TargetPath = '${exe}';`
    + ` $s.IconLocation = '${exe},0'; $s.WorkingDirectory = '${targetDir}';`
    + ` $s.Description = 'DeepSeek Harness Desktop'; $s.Save() }`
  await runPowershell(ps)
  // Explorer caches shortcut icons by target path; refresh the cache so the
  // freshly installed executable's icon replaces any stale cached one.
  try {
    execFileSync('ie4uinit.exe', ['-show'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* cosmetic; a stale icon cache recovers on the next shell refresh */
  }
  write('phase', 'shortcuts created')
}

async function writeRegistry(targetDir, write) {
  const exe = path.join(targetDir, 'DSH Desktop.exe')
  const key = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + APP_GUID
    const values = [
    ['DisplayName', 'DSH Desktop'],
    ['DisplayVersion', APP_VERSION],
    ['Publisher', 'DSH Desktop'],
    ['InstallLocation', targetDir],
    ['UninstallString', `"${exe}" --uninstall`],
    ['QuietUninstallString', `"${exe}" --uninstall --silent`],
    ['DisplayIcon', `${exe},0`],
  ]
  for (const [name, value] of values) {
    execFileSync('reg', ['add', key, '/v', name, '/d', value, '/f'], { stdio: 'ignore', windowsHide: true })
  }
  execFileSync('reg', ['add', key, '/v', 'NoModify', '/t', 'REG_DWORD', '/d', '1', '/f'], { stdio: 'ignore', windowsHide: true })
  execFileSync('reg', ['add', key, '/v', 'NoRepair', '/t', 'REG_DWORD', '/d', '1', '/f'], { stdio: 'ignore', windowsHide: true })
  write('phase', 'registry written')
}

let installerWindow = null
let workerStartedAt = 0

async function openInstallerWindow() {
  Menu.setApplicationMenu(null)
  installerWindow = new BrowserWindow({
    width: 560,
    height: 720,
    backgroundColor: '#08152d',
    frame: false,
    transparent: false,
    resizable: false,
    show: false,
    skipTaskbar: false,
    icon: appIconPath,
    title: 'DSH Desktop 安装',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  installerWindow.once('ready-to-show', () => {
    startupLog('installer window ready-to-show')
    installerWindow?.show()
  })
  installerWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    startupLog('installer page failed to load: ' + code + ' ' + desc + ' ' + url)
  })
  installerWindow.webContents.on('render-process-gone', (_e, details) => {
    startupLog('installer renderer gone: ' + JSON.stringify(details))
  })
  installerWindow.webContents.on('console-message', (_e, level, message) => {
    startupLog('installer console [' + level + '] ' + message)
  })
  void installerWindow.loadFile(path.join(import.meta.dirname, 'installer.html')).then(
    () => startupLog('installer.html load ok'),
    (err) => startupLog('installer.html load error: ' + String(err)),
  )

  ipcMain.handle('installer:defaults', () => ({
    target: readIniInstallPath(),
    version: APP_VERSION,
  }))

  ipcMain.handle('installer:choose-dir', async () => {
    if (installerWindow === null) return null
    const result = await dialog.showOpenDialog(installerWindow, {
      title: '选择安装目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('installer:start', async (_event, target) => {
    const exe = process.execPath
    const args = `--installer-worker "${target}"`
    // Clear the previous run's log so a stale "install complete" can never
    // masquerade as this run's result.
    try { await fsp.rm(INSTALL_LOG, { force: true }) } catch { /* best-effort */ }
    const ps = `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList '${args.replace(/'/g, "''")}' -Verb RunAs`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true })
    child.once('error', () => { /* the renderer detects missing log activity */ })
    child.unref()
    workerStartedAt = Date.now()
    return 'started'
  })

  ipcMain.handle('installer:log-tail', async () => {
    let raw = ''
    let mtimeMs = 0
    try {
      const stat = await fsp.stat(INSTALL_LOG)
      mtimeMs = stat.mtimeMs
      raw = await fsp.readFile(INSTALL_LOG, 'utf8')
    } catch { /* not yet */ }
    // Only trust entries written after this run started: a leftover log from
    // a previous install (whose tail ends in "100% ... install complete")
    // must neither finish this run nor be shown as this run's progress.
    const fresh = workerStartedAt > 0 && mtimeMs >= workerStartedAt - 1000
    const lines = fresh ? raw.split(/\r?\n/).filter(Boolean) : []
    const tail = lines.slice(-400)
    const complete = fresh && raw.includes('install complete')
    const failed = fresh && raw.includes('| error |')
    return { tail, complete, failed, waiting: !complete && !failed && workerStartedAt > 0 && tail.length === 0 }
  })

  ipcMain.handle('installer:finish', async (_event, launch) => {
    if (launch) {
      const installedExe = path.join(readIniInstallPath(), 'DSH Desktop.exe')
      const child = spawn(installedExe, [], { detached: true, stdio: 'ignore' })
      child.unref()
    }
    app.quit()
  })

  ipcMain.handle('installer:cancel', async () => {
    app.quit()
  })
}

// ==================== uninstall ====================

async function confirmAndUninstall() {
  const result = await dialog.showMessageBox({
    type: 'question',
    buttons: ['卸载', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: 'DSH Desktop 卸载',
    message: '确定要卸载 DSH Desktop 吗？',
    detail: '将删除应用文件与快捷方式。',
  })
  if (result.response !== 0) {
    app.quit()
    return
  }
  const exe = process.execPath
  const ps = `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList '--uninstall-worker' -Verb RunAs`
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true }).unref()
  app.quit()
}

async function runUninstallWorker() {
  const targetDir = path.dirname(process.execPath)
  const log = logLineSink(INSTALL_LOG)
  log.open('w')
  try {
    log.write('phase', `uninstall started; target=${targetDir}`)
    await originalFs.promises.rm(targetDir, { recursive: true, force: true })
    await originalFs.promises.rm('C:\\Users\\Public\\Desktop\\DSH Desktop.lnk', { force: true })
    await originalFs.promises.rm('C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\DSH Desktop.lnk', { force: true })
        execFileSync('reg', ['delete', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + APP_GUID, '/f'], { stdio: 'ignore', windowsHide: true })
    log.write('phase', 'uninstall complete')
  } catch (error) {
    log.write('error', String(error))
    log.close()
    app.exit(1)
    return
  }
  log.close()
  app.exit(0)
}

app.whenReady().then(() => {
  if (isInstallerWorker) {
    void runInstallerWorker().catch((error) => {
      startupLog('installer worker crashed: ' + String(error))
      app.exit(1)
    })
    return
  }
  if (isUninstallWorker) {
    void runUninstallWorker().catch((error) => {
      startupLog('uninstall worker crashed: ' + String(error))
      app.exit(1)
    })
    return
  }
  if (isUninstall) {
    void confirmAndUninstall()
    return
  }
  // Self-updater: checks the official repository baseline from the tools
  // window (检查更新) and applies updates through the installer worker.
  registerUpdateIpc({
    version: APP_VERSION,
    installed: () => app.isPackaged,
    installDir: () => path.dirname(process.execPath),
    kernelBundled: kernelBundledVersion,
    sendProgress: (payload) => {
      if (toolsWindow !== null && !toolsWindow.isDestroyed()) {
        toolsWindow.webContents.send('update:progress', payload)
      }
    },
    requestQuit: () => app.quit(),
  })
  if (app.isPackaged && !isInstalledHere()) {
    void openInstallerWindow()
    return
  }
  void boot()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  if (stopping) return
  stopping = true
  event.preventDefault()
  void stopHarnessProcess().finally(() => {
    app.exit()
  })
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})