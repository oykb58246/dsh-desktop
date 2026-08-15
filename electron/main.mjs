import { app, BrowserWindow, Menu, shell, ipcMain, screen, dialog, Tray, nativeImage } from 'electron'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { scanCodexProjects } from './codex-projects.mjs'
import { createRequire } from 'node:module'
// original-fs bypasses Electron's asar virtual-fs patch; the install worker
// must copy resources/app.asar as a plain file.
const require2 = createRequire(import.meta.url)
const originalFs = require2('original-fs')
import {
  decodeSegment,
  importSessionFromRollout,
  readSessionLogCwd,
  scanAllCodexSessions,
  defaultCodexSessionsRoot,
} from './codex-import.mjs'
import { registerUpdateIpc, runBackgroundCheck, compareVersions } from './updater.mjs'
import { changelog } from './changelog.mjs'
import { RemoteControl } from './remote-control.mjs'
import { injectComposerAttach } from './composer-attach.mjs'
import { injectCommandZh } from './command-zh.mjs'
import { injectTurnChrome } from './turn-chrome.mjs'
import { registerWorkspaceIpc } from './workspace-io.mjs'
import { registerFileRevertIpc } from './file-revert.mjs'
import { syncCompanionPlugins } from './companion-plugins.mjs'
import {
  listInstalledPlugins, searchPlugins, installPlugin, removePlugin, listLocalDrops,
} from './plugin-market.mjs'

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
// cloudflared ships inside the shell payload: electron-builder unpacks it
// (asarUnpack) so the main process can spawn the real executable.
const cloudflaredBin = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'vendor', 'cloudflared.exe')
  : path.join(desktopRoot, 'electron', 'vendor', 'cloudflared.exe')
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

// Changelog dialog payload staged in boot() and consumed by finishStartup
// once the harness page is loaded: non-null means first-open-of-day or
// first-open-after-update.
let pendingChangelog = null

// Tray + close-action state. `allowQuit` lets a deliberate exit bypass the
// "minimize or close" prompt; `tray` is created on first hide-to-tray.
let tray = null
let allowQuit = false
const windowPrefsPath = path.join(app.getPath('userData'), 'window-prefs.json')

// Web 远程控制服务（工具区面板驱动）：null 直到 boot 成功启动后创建。
let remoteControl = null

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
 * detect). Persisted as JSON under the user data directory.
 */
const codexImportConfigPath = path.join(app.getPath('userData'), 'codex-import-config.json')
let codexSessionsCustomRoot = null

// ---------- vision plugin config (Qwen-VL bridge) ----------
const visionConfigPath = path.join(app.getPath('userData'), 'vision-config.json')
const DEFAULT_VISION_CONFIG = {
  enabled: true,
  apiKey: '',
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-vl-max',
}
let visionConfig = { ...DEFAULT_VISION_CONFIG }

/** Load the persisted vision-plugin configuration (best-effort). */
async function loadVisionConfig() {
  try {
    const parsed = JSON.parse(await readFile(visionConfigPath, 'utf8'))
    visionConfig = {
      enabled: typeof parsed?.enabled === 'boolean' ? parsed.enabled : DEFAULT_VISION_CONFIG.enabled,
      apiKey: typeof parsed?.apiKey === 'string' ? parsed.apiKey : '',
      baseURL: typeof parsed?.baseURL === 'string' && parsed.baseURL.trim() !== ''
        ? parsed.baseURL.trim()
        : DEFAULT_VISION_CONFIG.baseURL,
      model: typeof parsed?.model === 'string' && parsed.model.trim() !== ''
        ? parsed.model.trim()
        : DEFAULT_VISION_CONFIG.model,
    }
  } catch {
    visionConfig = { ...DEFAULT_VISION_CONFIG }
  }
}

/** Persist the vision-plugin configuration. */
async function saveVisionConfig(next) {
  visionConfig = next
  await mkdir(path.dirname(visionConfigPath), { recursive: true })
  await writeFile(visionConfigPath, JSON.stringify(visionConfig, null, 2))
}

/** The cordis.patch.yml row carrying the vision bridge's live configuration. */
function visionPatchRow() {
  return [
    '- id: vision-qwen',
    '  config:',
    `    enabled: ${visionConfig.enabled === false ? 'false' : 'true'}`,
    `    baseURL: ${JSON.stringify(visionConfig.baseURL)}`,
    `    model: ${JSON.stringify(visionConfig.model)}`,
  ]
}

/**
 * Merge the generated vision row into a cordis.patch.yml text: an existing
 * `- id: vision-qwen` row is replaced in place (its config block runs until
 * the next top-level `- id:`); otherwise the row is appended.
 */
function mergeVisionPatchRow(text, lines) {
  const rows = text.split(/\r?\n/u)
  const start = rows.findIndex(line => line.trim() === '- id: vision-qwen')
  if (start === -1) {
    const trimmed = rows.filter(line => line.trim() !== '')
    return [...trimmed, ...lines, ''].join('\n')
  }
  let end = start + 1
  while (end < rows.length && !/^- id:/u.test(rows[end].trim())) end += 1
  return [...rows.slice(0, start), ...lines, ...rows.slice(end)].join('\n')
}

/** Write/remove one KEY= line in a dotenv-style file, keeping the rest. */
async function mergeEnvLine(filePath, key, value) {
  let text = ''
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    // The file does not exist yet; the write below creates it.
  }
  const lines = text.split(/\r?\n/u)
  const out = []
  let replaced = false
  for (const line of lines) {
    if (line.startsWith(`${key}=`)) {
      if (!replaced && value !== '') {
        out.push(`${key}=${value}`)
        replaced = true
      }
      continue
    }
    out.push(line)
  }
  if (!replaced && value !== '') out.push(`${key}=${value}`)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, out.join('\n').replace(/\s+$/u, '') + '\n', 'utf8')
}

/** Write/remove one `KEY: value` line in a YAML map file, keeping the rest. */
async function mergeYamlLine(filePath, key, value) {
  let text = ''
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    // The file does not exist yet; the write below creates it.
  }
  const lines = text.split(/\r?\n/u)
  const out = []
  let replaced = false
  for (const line of lines) {
    if (line.startsWith(`${key}:`)) {
      if (!replaced && value !== '') {
        out.push(`${key}: ${value}`)
        replaced = true
      }
      continue
    }
    out.push(line)
  }
  if (!replaced && value !== '') out.push(`${key}: ${value}`)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, out.join('\n').replace(/\s+$/u, '') + '\n', 'utf8')
}

/**
 * Push the current vision configuration into the Harness home: the
 * cordis.patch.yml row and the DashScope key. The key goes into
 * `$DSH_HOME/.credentials.yaml`, which the local credential provider watches
 * live — so a changed key takes effect on the next turn without a restart;
 * `$DSH_HOME/.env` keeps the same value as a boot-time fallback.
 */
async function applyVisionConfigToHarness() {
  const patchPath = path.join(dshHomeDir, 'cordis.patch.yml')
  let text = ''
  try {
    text = await readFile(patchPath, 'utf8')
  } catch {
    // First run: the file does not exist yet.
  }
  await mkdir(dshHomeDir, { recursive: true })
  await writeFile(patchPath, mergeVisionPatchRow(text, visionPatchRow()), 'utf8')
  const dashKey = visionConfig.apiKey.trim()
  await mergeYamlLine(path.join(dshHomeDir, '.credentials.yaml'), 'DASHSCOPE_API_KEY', dashKey)
  await mergeEnvLine(path.join(dshHomeDir, '.env'), 'DASHSCOPE_API_KEY', dashKey)
}

ipcMain.handle('vision:get-config', async () => ({ ...visionConfig }))

ipcMain.handle('vision:set-config', async (_event, next) => {
  const merged = {
    enabled: typeof next?.enabled === 'boolean' ? next.enabled : visionConfig.enabled,
    apiKey: typeof next?.apiKey === 'string' ? next.apiKey : visionConfig.apiKey,
    baseURL: typeof next?.baseURL === 'string' && next.baseURL.trim() !== ''
      ? next.baseURL.trim()
      : visionConfig.baseURL,
    model: typeof next?.model === 'string' && next.model.trim() !== ''
      ? next.model.trim()
      : visionConfig.model,
  }
  await saveVisionConfig(merged)
  await applyVisionConfigToHarness()
  return { ...merged }
})

/**
 * Test the vision connection with the given (or persisted) key / address /
 * model: one minimal OpenAI-protocol chat completion. Returns `{ ok, status,
 * message }`; a failed key or endpoint surfaces the provider's error text.
 */
ipcMain.handle('vision:test', async (_event, next) => {
  const key = (typeof next?.apiKey === 'string' ? next.apiKey : visionConfig.apiKey).trim()
  const baseURL = (typeof next?.baseURL === 'string' && next.baseURL.trim() !== '' ? next.baseURL.trim() : visionConfig.baseURL)
  const model = (typeof next?.model === 'string' && next.model.trim() !== '' ? next.model.trim() : visionConfig.model)
  if (key === '') return { ok: false, message: '尚未填写 API Key' }
  const url = `${baseURL.replace(/\/+$/u, '')}/chat/completions`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    })
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const parsed = await response.json()
        if (parsed?.error?.message) message = parsed.error.message
      } catch {
        // The status alone still identifies the failure.
      }
      return { ok: false, status: response.status, message }
    }
    return { ok: true, status: response.status, message: '连接成功：密钥与 API 地址有效' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
})

/** Load the persisted import configuration (best-effort). */
async function loadCodexImportConfig() {
  try {
    const parsed = JSON.parse(await readFile(codexImportConfigPath, 'utf8'))
    if (typeof parsed?.customSessionsRoot === 'string' && parsed.customSessionsRoot.trim() !== '') {
      codexSessionsCustomRoot = parsed.customSessionsRoot.trim()
    }
  } catch {
    codexSessionsCustomRoot = null
  }
}

/** Persist the import configuration (or remove the file when fully default). */
async function saveCodexImportConfig() {
  if (codexSessionsCustomRoot === null) {
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
  }
}

app.setAppUserModelId('com.oykb58246.dsh-desktop')

// ---------- installer constants & modes ----------
const APP_GUID = '2964e23e-3f18-500c-b3e7-68e9fa24df7a'
const APP_VERSION = '0.1.2'
const UNINSTALL_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + APP_GUID
const INI_PATH = 'C:\\dsh-desktop.ini'
const INSTALL_LOG = 'C:\\dsh-desktop-install.log'
const isInstallerWorker = process.argv.includes('--installer-worker')
const isUninstall = process.argv.includes('--uninstall')
const isUninstallWorker = process.argv.includes('--uninstall-worker')
const isAppInstance = !isInstallerWorker && !isUninstall && !isUninstallWorker
const isSecondaryInstance = isAppInstance && !app.requestSingleInstanceLock()

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

/**
 * Install a native text context menu (copy / paste / cut / select-all) on one
 * window. Electron ships no default context menu, so without this right-click
 * does nothing even where text is selectable.
 * @param window - the BrowserWindow whose webContents gets the menu.
 */
function installContextMenu(window) {
  window.webContents.on('context-menu', (_event, params) => {
    const hasSelection = params.selectionText.trim().length > 0
    const menu = Menu.buildFromTemplate([
      { role: 'copy', label: '复制', enabled: hasSelection || params.isEditable },
      { role: 'paste', label: '粘贴', enabled: params.isEditable },
      { role: 'cut', label: '剪切', enabled: params.isEditable },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' },
    ])
    menu.popup({ window })
  })
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

  mainWindow.on('close', (event) => {
    if (allowQuit || loadingWindow) return
    event.preventDefault()
    void handleMainClose()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.once('ready-to-show', () => {
    startupLog('main window ready-to-show')
    mainWindow?.show()
  })
  installContextMenu(mainWindow)
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

function readWindowPrefs() {
  try {
    const parsed = JSON.parse(readFileSync(windowPrefsPath, 'utf8'))
    return {
      closeAction: parsed?.closeAction === 'tray' || parsed?.closeAction === 'quit'
        ? parsed.closeAction
        : null,
    }
  } catch {
    return { closeAction: null }
  }
}

function writeWindowPrefs(next) {
  try {
    mkdirSync(path.dirname(windowPrefsPath), { recursive: true })
    writeFileSync(windowPrefsPath, JSON.stringify(next), 'utf8')
  } catch {
    /* a missing pref only means we ask again next time */
  }
}

function ensureTray() {
  if (tray !== null) return
  const icon = nativeImage.createFromPath(appIconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('DSH Desktop')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => restoreMainWindow() },
    { type: 'separator' },
    { label: '卸载 DSH Desktop', click: () => { void requestUninstall() } },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() },
  ]))
  tray.on('click', () => restoreMainWindow())
}

function restoreMainWindow() {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    return
  }
  mainWindow.setSkipTaskbar(false)
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function hideMainToTray() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  ensureTray()
  mainWindow.setSkipTaskbar(true)
  mainWindow.hide()
}

function quitApp() {
  allowQuit = true
  if (tray !== null) {
    tray.destroy()
    tray = null
  }
  app.quit()
}

async function handleMainClose() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  const prefs = readWindowPrefs()
  if (prefs.closeAction === 'tray') {
    hideMainToTray()
    return
  }
  if (prefs.closeAction === 'quit') {
    quitApp()
    return
  }
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['最小化到托盘', '直接关闭', '取消'],
    defaultId: 0,
    cancelId: 2,
    title: '关闭 DSH Desktop',
    message: '关闭窗口时要怎么处理？',
    detail: '最小化到托盘后，DSH 会继续在后台运行；直接关闭会退出应用。',
    checkboxLabel: '记住我的选择',
    checkboxChecked: false,
  })
  if (result.response === 2) return
  const action = result.response === 0 ? 'tray' : 'quit'
  if (result.checkboxChecked) writeWindowPrefs({ closeAction: action })
  if (action === 'tray') hideMainToTray()
  else quitApp()
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
    if (window === mainWindow) {
      if (loadingWindow) {
        quitApp()
        return
      }
      void handleMainClose()
      return
    }
    const closingTools = window === toolsWindow
    window.close()
    // Closing the tools window returns focus to the main harness window.
    if (closingTools && mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  }
})

ipcMain.handle('open-external', async (_event, url) => {
  // Only http(s) URLs may leave the shell; anything else is refused.
  if (!/^https?:\/\//u.test(String(url))) return false
  await shell.openExternal(String(url))
  return true
})

ipcMain.handle('composer:pick-files', async (event, opts) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  const images = opts?.images === true
  const result = await dialog.showOpenDialog(window ?? mainWindow, {
    title: images ? '选择图片' : '选择附件',
    properties: ['openFile', 'multiSelections'],
    filters: images
      ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
      : [{ name: 'All Files', extensions: ['*'] }],
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('plugin:installed', () => listInstalledPlugins(dshHomeDir))
ipcMain.handle('plugin:search', (_event, query) => searchPlugins(query))
ipcMain.handle('plugin:local', () => listLocalDrops(dshHomeDir))
ipcMain.handle('plugin:install', (_event, spec) => installPlugin({
  packaged: app.isPackaged,
  harnessEntry,
  harnessRoot,
  dshHome: dshHomeDir,
}, spec))
ipcMain.handle('plugin:remove', (_event, name) => removePlugin({
  packaged: app.isPackaged,
  harnessEntry,
  harnessRoot,
  dshHome: dshHomeDir,
}, name))

// ---------- archive management (harness workspace archive/restore) ----------

/** Call one api-proxy domain method on the running harness, returning its value. */
async function callHarnessRpc(method, payload) {
  if (harnessUrl === null) throw new Error('DSH 服务尚未就绪')
  const response = await fetch(`${harnessUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method,
      payload: payload ?? {},
    }),
  })
  const json = await response.json()
  if (json?.result?.ok !== true) {
    throw new Error(json?.result?.error?.message ?? `RPC ${method} 失败`)
  }
  return json.result.value
}

ipcMain.handle('archive:list', async () => {
  // listArchived → { workspaces, archivedSessionIds }
  const value = await callHarnessRpc('workspace.listArchived', {})
  return {
    workspaces: value.workspaces ?? [],
    sessions: (value.archivedSessionIds ?? []).map(id => ({ sessionId: String(id) })),
  }
})

ipcMain.handle('archive:restore-workspace', async (_event, workspaceId) => {
  return await callHarnessRpc('workspace.unarchive', { workspaceId })
})

ipcMain.handle('archive:restore-session', async (_event, sessionId) => {
  return await callHarnessRpc('workspace.unarchiveSession', { sessionId })
})

// ---------- web remote control (工具区「Web 远程控制」面板) ----------

/** Push one remote-control snapshot to the tools window, when open. */
function sendRemoteState(payload) {
  if (toolsWindow === null || toolsWindow.isDestroyed()) return
  toolsWindow.webContents.send('remote:state', payload)
}

/** Create the remote-control service once the harness URL is known. */
function ensureRemoteControl() {
  if (remoteControl !== null) return
  remoteControl = new RemoteControl({
    configPath: path.join(app.getPath('userData'), 'remote-control.json'),
    cloudflaredBin,
    getHarnessTarget: () => {
      if (harnessUrl === null) return null
      try {
        const url = new URL(harnessUrl)
        return { host: url.hostname, port: Number(url.port) }
      } catch {
        return null
      }
    },
    sendState: sendRemoteState,
  })
}

/** Render one text as an SVG QR code (vendor qrcode-generator, offline). */
function renderQrSvg(text) {
  const qrcode = require2('./vendor/qrcode.cjs')
  const qr = qrcode(0, 'L')
  qr.addData(String(text), 'Byte')
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}

ipcMain.handle('remote:get-state', async () => {
  if (remoteControl === null) return null
  await remoteControl.probeLan()
  return remoteControl.snapshot()
})

ipcMain.handle('remote:set-lan', async (_event, enabled) => {
  if (remoteControl === null) return null
  remoteControl.setLan(enabled === true)
  return remoteControl.snapshot()
})

ipcMain.handle('remote:set-public', async (_event, enabled) => {
  if (remoteControl === null) return null
  remoteControl.setPublic(enabled === true)
  return remoteControl.snapshot()
})

ipcMain.handle('remote:refresh', async () => {
  if (remoteControl === null) return null
  await remoteControl.probeLan(true)
  return remoteControl.snapshot()
})

ipcMain.handle('remote:reset-token', async () => {
  if (remoteControl === null) return null
  await remoteControl.resetToken()
  return remoteControl.snapshot()
})

ipcMain.handle('remote:set-port', async (_event, port) => {
  if (remoteControl === null) return null
  await remoteControl.setPort(port)
  return remoteControl.snapshot()
})

ipcMain.handle('remote:qr', (_event, text) => {
  if (typeof text !== 'string' || text === '' || text.length > 512) return null
  try {
    return renderQrSvg(text)
  } catch {
    return null
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
  installContextMenu(toolsWindow)
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
      // A session counts as imported only when the stored log's cwd equals the
      // Codex project directory. Legacy imports (copied into a Documents
      // target) stored a different cwd, so they re-import under the new
      // workspace-references-original-directory rules instead of being skipped.
      const storedCwd = imported.get(session.id)
      session.imported = storedCwd !== undefined && storedCwd === session.cwd
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

/**
 * One-shot import: register each chosen project's ORIGINAL directory as a dsh
 * workspace (nothing is copied), convert the chosen Codex rollouts into dsh
 * session logs rooted at that directory, and attach the sessions to the
 * workspace. Streams progress; resolves with per-project results.
 */
ipcMain.handle('codex-import-run', async (_event, { selection }) => {
  const results = []
  for (const item of selection) {
    // The workspace references the original Codex project directory; sessions
    // keep it as their cwd, so no files are ever copied.
    const cwd = item.cwd
    const written = []
    const skipped = []
    for (const rollout of item.rollouts) {
      try {
        const outcome = await importSessionFromRollout({
          rollout: rollout.file,
          cwd,
          sessionId: rollout.id || undefined,
          dshHome: dshHomeDir,
          onEvent: (event) => sendToolsProgress({ kind: 'session-progress', phase: event.kind, project: item.name, ...event }),
        })
        written.push(outcome)
      } catch (error) {
        skipped.push({ id: rollout.id ?? rollout.file, error: error instanceof Error ? error.message : String(error) })
      }
    }

    // Shallow groups (drive roots, the user profile, aggregate folders) stay
    // session-only: their cwd is not a project and is never registered.
    let workspace = null
    if (harnessUrl !== null && !item.shallow && typeof cwd === 'string' && cwd.trim() !== '') {
      try {
        const createBody = {
          type: 'client-request',
          rpcId: randomUUID(),
          method: 'workspace.create',
          payload: { path: cwd },
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

    results.push({ name: item.name, cwd, written, skipped, workspace })
  }
  return results
})

// ---------- changelog dialog (post install/update) ----------

/** Path of the small JSON tracking the last changelog show (version + local date). */
const seenVersionPath = path.join(app.getPath('userData'), 'seen-version.json')

function todayStamp() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function readSeenChangelog() {
  try {
    const parsed = JSON.parse(readFileSync(seenVersionPath, 'utf8'))
    return {
      version: typeof parsed?.version === 'string' ? parsed.version : null,
      shownOn: typeof parsed?.shownOn === 'string' ? parsed.shownOn : null,
    }
  } catch {
    return { version: null, shownOn: null }
  }
}

function writeSeenChangelog(version, shownOn) {
  try {
    mkdirSync(path.dirname(seenVersionPath), { recursive: true })
    writeFileSync(seenVersionPath, JSON.stringify({ version, shownOn }), 'utf8')
  } catch {
    // A missing marker only means the dialog may show again next boot.
  }
}

/**
 * Show the changelog on the first open of the local day, or the first open
 * after the app version changed (install / update). Later launches the same
 * day stay quiet.
 */
function changelogForLaunch() {
  const seen = readSeenChangelog()
  const today = todayStamp()
  const updated = seen.version === null || compareVersions(APP_VERSION, seen.version) !== 0
  const firstToday = seen.shownOn !== today
  if (!updated && !firstToday) return null
  const kind = seen.version === null ? 'fresh' : updated ? 'update' : 'daily'
  return { entries: changelog, kind }
}

/** Show the staged changelog dialog in the main window, then mark the version as seen. */
async function maybeShowChangelog() {
  const pending = pendingChangelog
  pendingChangelog = null
  if (pending === null) {
    writeSeenChangelog(APP_VERSION, todayStamp())
    return
  }
  try {
    await injectChangelogDialog(pending.entries, pending.kind)
    // Only persist after a successful injection so a transient failure retries
    // on the next boot instead of silently dropping the announcement.
    writeSeenChangelog(APP_VERSION, todayStamp())
  } catch (error) {
    startupLog('changelog inject failed: ' + String(error))
  }
}

/**
 * Inject the changelog overlay into the harness page: current version on top,
 * scrollable 历史更新日志 below, matching the window-chrome themes.
 */
async function injectChangelogDialog(entries, kind) {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  await mainWindow.webContents.executeJavaScript(`(() => {
    if (document.getElementById('dsh-changelog-overlay')) return;
    const data = ${JSON.stringify({ entries, kind })};
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const sections = data.entries.map((e, i) => {
      const divider = i === 1
        ? '<div style="margin:4px 0 12px; padding-top:14px; border-top:1px solid rgba(255,255,255,.08); color:#7d97c4; font-size:12px; letter-spacing:.06em;">历史更新日志</div>'
        : '';
      const list = e.notes.map(n => '<li>' + esc(n) + '</li>').join('');
      return divider
        + '<div style="margin-bottom:16px;"><div style="font-weight:600; color:#d6e4ff;">v' + esc(e.version)
        + ' <span style="color:#7d97c4; font-weight:400; font-size:12px; margin-left:6px;">' + esc(e.date) + ' · ' + esc(e.title) + '</span></div>'
        + '<ul style="margin:6px 0 0; padding-left:18px; color:#c6d6f2;">' + list + '</ul></div>';
    }).join('');
    const overlay = document.createElement('div');
    overlay.id = 'dsh-changelog-overlay';
    overlay.innerHTML =
      '<div style="position:fixed; left:0; right:0; top:42px; bottom:0; z-index:2147483646; display:flex; align-items:center; justify-content:center; background:rgba(4,10,24,.55);">'
      + '<div style="width:560px; max-width:94vw; max-height:82%; display:flex; flex-direction:column; border-radius:14px; background:#101827; border:1px solid rgba(255,255,255,.1); color:#eef3ff; font:13px/1.65 \\'Segoe UI\\',\\'Microsoft YaHei\\',sans-serif; box-shadow:0 22px 60px rgba(0,0,0,.55); overflow:hidden;">'
      + '<div style="padding:16px 20px 10px; border-bottom:1px solid rgba(255,255,255,.08);">'
      + '<div style="font-size:15px; font-weight:600;">' + (data.kind === 'fresh' ? '欢迎使用 DSH Desktop' : data.kind === 'update' ? 'DSH Desktop 已更新' : '今日更新说明') + ' <span style="color:#8fb3ff;">v' + esc(data.entries[0].version) + '</span></div>'
      + '<div style="color:#9fb4d8; font-size:12px; margin-top:2px;">' + (data.kind === 'fresh' ? '安装完成，本次发布内容如下：' : data.kind === 'update' ? '更新完成，本次发布内容如下：' : '每天首次打开会展示一次当前版本说明：') + '</div>'
      + '</div>'
      + '<div style="overflow-y:auto; padding:12px 20px 14px; flex:1;">' + sections + '</div>'
      + '<div style="padding:10px 20px; border-top:1px solid rgba(255,255,255,.08); display:flex; justify-content:flex-end;">'
      + '<button id="dsh-changelog-close" style="border:0; border-radius:8px; padding:7px 22px; font-size:13px; color:#fff; background:#4d6bfe; cursor:pointer;">知道了</button>'
      + '</div></div></div>';
    const style = document.createElement('style');
    style.textContent =
      'html.dsh-light #dsh-changelog-overlay > div { background:#f7f9fc; color:#17212b; border-color:rgba(23,33,43,.12); } '
      + 'html.dsh-light #dsh-changelog-overlay ul { color:#3a4a63; } '
      + 'html.dsh-light #dsh-changelog-overlay div { color:inherit; } '
      + 'html.dsh-light #dsh-changelog-overlay div[style*="color:#7d97c4"], html.dsh-light #dsh-changelog-overlay div[style*="color:#9fb4d8"] { color:#6b7f9e; }';
    document.head.appendChild(style);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#dsh-changelog-close').addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || event.target === overlay.firstElementChild) close();
    });
    document.addEventListener('keydown', function onKey(event) {
      if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });
  })()`)
}

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
      #dsh-window-chrome { position: fixed; inset: 0 0 auto 0; height: 42px; z-index: 2147483600; display:flex; align-items:center; gap:10px; padding:0 10px 0 14px; color:#eef3ff; background:#171d2a; border-bottom:1px solid rgba(255,255,255,.08); font:600 13px "Segoe UI", "Microsoft YaHei", sans-serif; -webkit-app-region:drag; user-select:none; }
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
      #dsh-window-chrome .dsh-tools { align-self:center; height:28px; border-radius:8px; background:linear-gradient(180deg,rgba(109,134,255,.30),rgba(77,107,254,.16)); border:1px solid rgba(130,152,255,.38); color:#c9d8ff; }
      #dsh-window-chrome .dsh-tools svg { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:16px; height:16px; }
      #dsh-window-chrome .dsh-tools:hover { background:linear-gradient(180deg,rgba(130,152,255,.44),rgba(77,107,254,.30)); color:#fff; }
      #dsh-window-chrome .dsh-tools.has-update::after { display:block; content:""; position:absolute; top:7px; right:8px; width:8px; height:8px; border-radius:50%; background:#4d8bfd; box-shadow:0 0 8px rgba(77,139,253,.95); }
      html.dsh-light #dsh-window-chrome .dsh-tools { background:linear-gradient(180deg,rgba(77,107,254,.16),rgba(77,107,254,.08)); border-color:rgba(77,107,254,.34); color:#3b56c9; }
      html.dsh-light #dsh-window-chrome .dsh-tools:hover { background:linear-gradient(180deg,rgba(77,107,254,.28),rgba(77,107,254,.16)); }
      #dsh-window-chrome button:hover { background:rgba(255,255,255,.10); opacity:1; }
      #dsh-window-chrome button[data-action="close"]:hover { background:#d94b5b; }
      html.dsh-light #dsh-window-chrome { color:#17212b; background:#f7f9fc; border-bottom-color:rgba(23,33,43,.12); }
      html.dsh-light #dsh-window-chrome button:hover { background:rgba(23,33,43,.08); }
      html.dsh-light #dsh-window-chrome button[data-action="close"]:hover { color:white; background:#d94b5b; }
      html { height:100% !important; overflow:hidden !important; overscroll-behavior:none; }
      body { height:100% !important; max-height:100% !important; box-sizing:border-box !important; overflow:hidden !important; padding-top:42px !important; }
      [class*="toggleCluster"] { top: 7px !important; right: 214px !important; z-index: 2147483647 !important; }
      #dsh-window-chrome .dsh-desk-toggle, #dsh-desk-side, #dsh-desk-term { display: none !important; }
    \`;
    document.head.appendChild(style); document.body.appendChild(bar);
    document.documentElement.setAttribute('data-dsh-title-bar-height', '42');
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
    // The vision bridge resolves DASHSCOPE_API_KEY from the credential seam;
    // the launch environment is its first layer, the written $DSH_HOME/.env
    // its durable fallback.
    ...(visionConfig.apiKey.trim() === '' ? {} : { DASHSCOPE_API_KEY: visionConfig.apiKey.trim() }),
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
        try {
          await injectComposerAttach(mainWindow.webContents)
        } catch (error) {
          startupLog('composer attach inject failed: ' + String(error))
        }
        try {
          await injectCommandZh(mainWindow.webContents)
        } catch (error) {
          startupLog('command zh inject failed: ' + String(error))
        }
        try {
          await injectTurnChrome(mainWindow.webContents)
        } catch (error) {
          startupLog('turn chrome inject failed: ' + String(error))
        }
        await maybeShowChangelog()
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
    await loadVisionConfig()
    await applyVisionConfigToHarness()
    await ensureHarnessReady()
    try {
      const packedPlugins = path.join(import.meta.dirname, 'plugins')
      const unpackedPlugins = path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'plugins')
      syncCompanionPlugins({
        pluginsRoot: existsSync(unpackedPlugins) ? unpackedPlugins : packedPlugins,
        dshHome: dshHomeDir,
        harnessRoot,
        log: (line) => startupLog('companion: ' + line),
      })
    } catch (error) {
      startupLog('companion sync failed: ' + String(error))
    }
    // Stage the post-install/post-update changelog dialog before the harness
    // page exists; finishStartup shows it once the page is loaded.
    pendingChangelog = changelogForLaunch()
    await launchHarness()
    // Restore the remote-control switches the user left on: the forwarder
    // targets harnessUrl, which launchHarness has just resolved.
    ensureRemoteControl()
    await remoteControl.restore()
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

/**
 * Add or remove the Windows Defender exclusion for an install directory. The
 * Go installer adds it so the freshly extracted app tree skips real-time
 * scanning (the dominant cold-start cost); uninstall removes it. Best-effort:
 * Defender may be absent, policy-managed, or superseded by a third-party AV.
 * @param dir - the install directory.
 * @param remove - true removes the exclusion, false adds it.
 */
function applyDefenderExclusion(dir, remove) {
  const verb = remove ? 'Remove' : 'Add'
  const escaped = String(dir).replace(/'/g, "''")
  const command = `try { ${verb}-MpPreference -ExclusionPath '${escaped}' -ErrorAction Stop } catch {}`
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* best-effort; the install/update still completes without it */
  }
}

/**
 * PIDs of processes whose executable lies under one directory (the install
 * target). Escaping is single-quote doubling for the PowerShell string.
 * @param dir - absolute install-target directory.
 * @returns the matching process ids.
 */
async function runningProcessesUnder(dir) {
  const escaped = dir.replace(/'/g, "''")
  const out = await runPowershell(
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and `
    + `$_.ExecutablePath.ToLower().StartsWith('${escaped}'.TrimEnd('\\').ToLower() + '\\') } `
    + `| Select-Object -ExpandProperty ProcessId`,
  )
  return out.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => /^\d+$/u.test(line))
    .map(Number)
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
    // The bundled runtime lives inside the installer exe itself (appended by
    // scripts/append-payload.mjs); the native loader hands its own path over
    // via DSH_SETUP_EXE. Extract it straight to the target — one copy only.
    const payloadExe = process.env.DSH_SETUP_EXE
    if (payloadExe !== undefined && payloadExe !== '' && existsSync(payloadExe)) {
      write('phase', 'extracting bundled runtime')
      await extractRuntimePayload(payloadExe, targetDir, write)
    }
    write('phase', 'files copied; creating shortcuts')
    await createShortcuts(targetDir, write)
    write('phase', 'registering application')
    await writeRegistry(targetDir, write)
    // Keep the Defender exclusion from the original Go install in sync: an
    // update writes the same directory, so (re-)adding is a no-op safeguard.
    applyDefenderExclusion(targetDir, false)
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

async function hashFile(filePath) {
  const data = await originalFs.promises.readFile(filePath)
  return createHash('sha256').update(data).digest('hex')
}

async function copyTreeWithProgress(sourceDir, targetDir, write) {
  const files = []
  async function walk(dir, prefix) {
    for (const entry of await originalFs.promises.readdir(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, rel + '\\')
      } else if (entry.isFile() && entry.name !== '.dsh-shell-marker') {
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
    // Skip files that already match: an overlay update must not rewrite the
    // unchanged Electron shell / runtime tree on every launch.
    try {
      const current = await originalFs.promises.stat(dest)
      if (current.size === file.size) {
        const [srcHash, dstHash] = await Promise.all([hashFile(file.full), hashFile(dest)])
        if (srcHash === dstHash) {
          copied += file.size
          count += 1
          continue
        }
      }
    } catch {
      /* dest missing or unreadable — fall through to copy */
    }
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

/**
 * Read the runtime payload section appended to the installer exe
 * (`[runtime files][manifest][u32 len][DSHPLD01]`) and write every file under
 * `<target>/resources/dsh-runtime`. This is the single copy that installs the
 * bundled data — it comes straight out of the installer executable.
 * @param exePath - the installer exe (the native loader) carrying the payload.
 * @param targetDir - the installation directory.
 * @param write - the log sink `(kind, text)`.
 */
async function extractRuntimePayload(exePath, targetDir, write) {
  const handle = await originalFs.promises.open(exePath, 'r')
  try {
    const stat = await handle.stat()
    if (stat.size < 12) throw new Error('installer exe is too small')
    const tail = Buffer.alloc(12)
    await handle.read(tail, 0, 12, stat.size - 12)
    if (tail.subarray(4, 12).toString('utf8') !== 'DSHPLD01') {
      throw new Error('runtime payload section missing from the installer exe')
    }
    const manifestLen = tail.readUInt32LE(0)
    const manifestBuf = Buffer.alloc(manifestLen)
    await handle.read(manifestBuf, 0, manifestLen, stat.size - 12 - manifestLen)
    const manifest = JSON.parse(manifestBuf.toString('utf8'))
    const files = Array.isArray(manifest?.files) ? manifest.files : []
    const base = path.join(targetDir, 'resources', 'dsh-runtime')
    const total = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
    let done = 0
    let count = 0
    let lastPercent = -1
    for (const file of files) {
      const dest = path.join(base, ...String(file.path).split('/'))
      await originalFs.promises.mkdir(path.dirname(dest), { recursive: true })
      const size = Number(file.size) || 0
      const offset = Number(file.offset) || 0
      const want = typeof file.sha256 === 'string' ? file.sha256 : ''
      if (want !== '' && existsSync(dest)) {
        try {
          const current = await originalFs.promises.stat(dest)
          if (current.size === size && await hashFile(dest) === want) {
            done += size
            count += 1
            continue
          }
        } catch {
          /* dest unreadable — rewrite */
        }
      }
      const buf = Buffer.alloc(size)
      await handle.read(buf, 0, size, offset)
      await originalFs.promises.writeFile(dest, buf)
      done += size
      count += 1
      write('file', path.join('resources', 'dsh-runtime', String(file.path)))
      const percent = total > 0 ? Math.floor((done * 100) / total) : 100
      if (percent !== lastPercent) {
        lastPercent = percent
        write('progress', `${percent}% (${count} files)`)
      }
    }
    write('progress', '100%')
  } finally {
    await handle.close()
  }
}

async function createShortcuts(targetDir, write) {
  const exe = path.join(targetDir, 'DSH Desktop.exe')
  const desktopLink = 'C:\\Users\\Public\\Desktop\\DSH Desktop.lnk'
  const menuLink = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\DSH Desktop.lnk'
  const uninstallLink = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\卸载 DSH Desktop.lnk'
  const ps = `$ws = New-Object -ComObject WScript.Shell;`
    + ` foreach ($p in @('${desktopLink}', '${menuLink}')) {`
    + ` $s = $ws.CreateShortcut($p); $s.TargetPath = '${exe}';`
    + ` $s.IconLocation = '${exe},0'; $s.WorkingDirectory = '${targetDir}';`
    + ` $s.Description = 'DeepSeek Harness Desktop'; $s.Save() };`
    + ` $u = $ws.CreateShortcut('${uninstallLink}'); $u.TargetPath = '${exe}';`
    + ` $u.Arguments = '--uninstall'; $u.IconLocation = '${exe},0';`
    + ` $u.Description = '卸载 DSH Desktop'; $u.Save()`
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
    // Dev preview (`--installer-ui`): the UI is reviewable but a real install
    // requires the packaged worker, so refuse the action in dev mode.
    if (!app.isPackaged) return 'dev-preview'
    // Let the user decide whether to stop an already-running install/update
    // target: the worker copies INTO `target`, and a running app from that
    // directory locks its files. Only processes whose executable lives under
    // the target are considered — the installer's own window (a temp-extracted
    // copy) never matches, so it survives the cleanup.
    const runningPids = await runningProcessesUnder(target)
    if (runningPids.length > 0) {
      const choice = await dialog.showMessageBox(installerWindow, {
        type: 'question',
        buttons: ['结束并继续', '取消'],
        defaultId: 0,
        cancelId: 1,
        title: '检测到正在运行的 DSH Desktop',
        message: `检测到 ${runningPids.length} 个 DSH Desktop 进程正在运行（安装目录：${target}）。`,
        detail: '继续安装或更新前需要结束这些进程。是否立即结束它们并继续？',
      })
      if (choice.response !== 0) return 'cancelled'
      for (const pid of runningPids) {
        try { process.kill(pid) } catch { /* already gone */ }
      }
      // Grace period, then force-kill whatever survived.
      await new Promise(resolve => setTimeout(resolve, 1500))
      for (const pid of await runningProcessesUnder(target)) {
        try {
          execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true })
        } catch { /* already gone */ }
      }
      await new Promise(resolve => setTimeout(resolve, 800))
    }
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

function writeUninstallScript(targetDir) {
  const script = path.join(tmpdir(), 'dsh-desktop-uninstall.ps1')
  const escaped = targetDir.replace(/'/g, "''")
  const body = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$target = '${escaped}'`,
    'Start-Sleep -Seconds 2',
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($target.TrimEnd('\\').ToLower() + '\\') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    'Start-Sleep -Seconds 1',
    `try { Remove-MpPreference -ExclusionPath $target -ErrorAction SilentlyContinue } catch {}`,
    'Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue',
    `Remove-Item -LiteralPath 'C:\\Users\\Public\\Desktop\\DSH Desktop.lnk' -Force`,
    `Remove-Item -LiteralPath 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\DSH Desktop.lnk' -Force`,
    `Remove-Item -LiteralPath 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\卸载 DSH Desktop.lnk' -Force`,
    `Remove-Item -LiteralPath (Join-Path $env:USERPROFILE 'Desktop\\DSH Desktop.lnk') -Force`,
    `Remove-Item -LiteralPath (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\DSH Desktop.lnk') -Force`,
    `Remove-Item -LiteralPath 'C:\\dsh-desktop.ini' -Force`,
    `reg delete 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_GUID}' /f`,
    "Add-Type -AssemblyName PresentationFramework",
    "[System.Windows.MessageBox]::Show('DSH Desktop 已卸载。','DSH Desktop')",
    '',
  ].join('\r\n')
  writeFileSync(script, body, 'utf8')
  return script
}

async function requestUninstall() {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const prompt = {
    type: 'question',
    buttons: ['立即卸载', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '卸载 DSH Desktop',
    message: '确定要卸载 DSH Desktop 吗？',
    detail: '将删除安装目录、开始菜单/桌面快捷方式和注册表项。用户数据（对话、设置）默认保留。',
  }
  const result = parent
    ? await dialog.showMessageBox(parent, prompt)
    : await dialog.showMessageBox(prompt)
  if (result.response !== 0) return { ok: false, cancelled: true }
  const targetDir = app.isPackaged ? path.dirname(process.execPath) : desktopRoot
  const script = writeUninstallScript(targetDir)
  const quoted = script.replace(/'/g, "''")
  spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Start-Process powershell.exe -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${quoted}"' -Verb RunAs`,
  ], { stdio: 'ignore', windowsHide: true }).unref()
  setTimeout(() => quitApp(), 400)
  return { ok: true }
}

async function confirmAndUninstall() {
  const result = await requestUninstall()
  if (result.cancelled) app.quit()
}

ipcMain.handle('app:uninstall', () => requestUninstall())

async function runUninstallWorker() {
  const targetDir = path.dirname(process.execPath)
  const log = logLineSink(INSTALL_LOG)
  log.open('w')
  try {
    log.write('phase', `uninstall started; target=${targetDir}`)
    // Remove the Defender exclusion added at install time before deleting
    // the tree, so no stale path exclusion is left behind.
    applyDefenderExclusion(targetDir, true)
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
  if (isSecondaryInstance) {
    app.quit()
    return
  }
  if (isAppInstance) {
    app.on('second-instance', () => restoreMainWindow())
  }
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
  registerFileRevertIpc(async () => {
    try {
      const value = await callHarnessRpc('workspace.list', {})
      return (value.items ?? []).map((item) => item.path).filter(Boolean)
    } catch {
      return []
    }
  })
  registerWorkspaceIpc({
    checkpointRoot: () => path.join(app.getPath('userData'), 'workspace-checkpoints'),
    getWorkspaces: async () => {
      const value = await callHarnessRpc('workspace.list', {})
      return { items: value.items ?? [] }
    },
    sendToMain: (channel, payload) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload)
      }
    },
  })
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
  // Installer UI preview: `--installer-ui` opens the installer window in any
  // mode (dev included) so the three-step flow can be reviewed without a real
  // install. The install action itself stays guarded to packaged runs.
  if (process.argv.includes('--installer-ui')) {
    void openInstallerWindow()
    return
  }
  if (app.isPackaged && !isInstalledHere()) {
    void openInstallerWindow()
    return
  }
  void boot()
})

app.on('window-all-closed', () => {
  if (tray !== null && !allowQuit) return
  if (process.platform !== 'darwin') {
    quitApp()
  }
})

app.on('before-quit', (event) => {
  if (stopping) return
  stopping = true
  allowQuit = true
  if (tray !== null) {
    tray.destroy()
    tray = null
  }
  event.preventDefault()
  remoteControl?.dispose()
  void stopHarnessProcess().finally(() => {
    app.exit()
  })
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})