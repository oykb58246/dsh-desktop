import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('dshDesktop', {
  onStatus(callback) {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('status', listener)
    return () => ipcRenderer.removeListener('status', listener)
  },
  windowAction(action) {
    ipcRenderer.send('window-action', action)
  },
  /** Open a URL in the system browser. */
  openExternal(url) {
    return ipcRenderer.invoke('open-external', String(url))
  },
  /** Resolve the real filesystem path of a File from paste/drop (Electron). */
  getPathForFile(file) {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return typeof file?.path === 'string' ? file.path : ''
    }
  },
  /** Native file picker; returns absolute paths. */
  pickFiles(opts) {
    return ipcRenderer.invoke('composer:pick-files', opts ?? {})
  },
  pluginInstalled() {
    return ipcRenderer.invoke('plugin:installed')
  },
  pluginSearch(query) {
    return ipcRenderer.invoke('plugin:search', query)
  },
  pluginLocal() {
    return ipcRenderer.invoke('plugin:local')
  },
  pluginInstall(spec) {
    return ipcRenderer.invoke('plugin:install', spec)
  },
  pluginRemove(name) {
    return ipcRenderer.invoke('plugin:remove', name)
  },
  wsList() { return ipcRenderer.invoke('ws:list') },
  wsTree(payload) { return ipcRenderer.invoke('ws:tree', payload) },
  wsRead(payload) { return ipcRenderer.invoke('ws:read', payload) },
  wsWrite(payload) { return ipcRenderer.invoke('ws:write', payload) },
  wsReveal(payload) { return ipcRenderer.invoke('ws:reveal', payload) },
  wsOpenExternal(payload) { return ipcRenderer.invoke('ws:open-external', payload) },
  wsHistory(payload) { return ipcRenderer.invoke('ws:history', payload) },
  wsRollback(payload) { return ipcRenderer.invoke('ws:rollback', payload) },
  wsCheckpoint(payload) { return ipcRenderer.invoke('ws:checkpoint', payload) },
  wsRestoreCheckpoint(payload) { return ipcRenderer.invoke('ws:restore-checkpoint', payload) },
  termStart(payload) { return ipcRenderer.invoke('term:start', payload) },
  termWrite(payload) { return ipcRenderer.invoke('term:write', payload) },
  termStop() { return ipcRenderer.invoke('term:stop') },
  onTermData(callback) {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('term:data', listener)
    return () => ipcRenderer.removeListener('term:data', listener)
  },
  onTermExit(callback) {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('term:exit', listener)
    return () => ipcRenderer.removeListener('term:exit', listener)
  },
  startUninstall() {
    return ipcRenderer.invoke('app:uninstall')
  },
  revertFiles(changes) {
    return ipcRenderer.invoke('dsh:file-revert', { changes })
  },
  openPath(filePath) {
    return ipcRenderer.invoke('ws:reveal', { path: filePath })
  },
  /** Read the persisted import configuration (sessions root). */
  getImportConfig() {
    return ipcRenderer.invoke('codex-import-get-config')
  },
  /** Scan the effective Codex sessions root into projects + rollouts. */
  scanAll() {
    return ipcRenderer.invoke('codex-import-scan-all')
  },
  /** One-shot import of the selected projects/sessions. */
  runImport(selection) {
    return ipcRenderer.invoke('codex-import-run', { selection })
  },
  /** Pick a custom Codex sessions directory and persist it. */
  chooseSessionsRoot() {
    return ipcRenderer.invoke('codex-sessions-choose')
  },
  /** Reset the sessions directory to the auto-detected default. */
  resetSessionsRoot() {
    return ipcRenderer.invoke('codex-sessions-reset')
  },
  onImportProgress(callback) {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('codex-import-progress', listener)
    return () => ipcRenderer.removeListener('codex-import-progress', listener)
  },

  /** Self-updater bridges: check the official repository baseline and apply
   *  updates in one click (used by the 检查更新 tool panel). */
  updateInfo() {
    return ipcRenderer.invoke('update:info')
  },
  updateCheck() {
    return ipcRenderer.invoke('update:check')
  },
  updateDownload() {
    return ipcRenderer.invoke('update:download')
  },
  updateCancel() {
    return ipcRenderer.invoke('update:cancel')
  },
  updateApply() {
    return ipcRenderer.invoke('update:apply')
  },
  updateOpenRepo() {
    return ipcRenderer.invoke('update:open-repo')
  },
  onUpdateProgress(callback) {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('update:progress', listener)
    return () => ipcRenderer.removeListener('update:progress', listener)
  },
  onUpdateAvailable(callback) {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('update:available', listener)
    return () => ipcRenderer.removeListener('update:available', listener)
  },
  /** Vision plugin (built-in Qwen-VL bridge) configuration bridges. */
  visionGetConfig() {
    return ipcRenderer.invoke('vision:get-config')
  },
  visionSetConfig(next) {
    return ipcRenderer.invoke('vision:set-config', next)
  },
  visionTest(next) {
    return ipcRenderer.invoke('vision:test', next)
  },
  /** Archive management bridges (restore archived workspaces/sessions). */
  archiveList() {
    return ipcRenderer.invoke('archive:list')
  },
  archiveRestoreWorkspace(workspaceId) {
    return ipcRenderer.invoke('archive:restore-workspace', workspaceId)
  },
  archiveRestoreSession(sessionId) {
    return ipcRenderer.invoke('archive:restore-session', sessionId)
  },
  /** Web 远程控制 bridges（工具区「Web 远程控制」面板）。 */
  remoteGetState() {
    return ipcRenderer.invoke('remote:get-state')
  },
  remoteSetLan(enabled) {
    return ipcRenderer.invoke('remote:set-lan', enabled)
  },
  remoteSetPublic(enabled) {
    return ipcRenderer.invoke('remote:set-public', enabled)
  },
  remoteRefresh() {
    return ipcRenderer.invoke('remote:refresh')
  },
  remoteResetToken() {
    return ipcRenderer.invoke('remote:reset-token')
  },
  remoteSetPort(port) {
    return ipcRenderer.invoke('remote:set-port', port)
  },
  remoteQr(text) {
    return ipcRenderer.invoke('remote:qr', text)
  },
  onRemoteState(callback) {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('remote:state', listener)
    return () => ipcRenderer.removeListener('remote:state', listener)
  },
  /** Installer UI bridges (used by installer.html). */
  installerDefaults() {
    return ipcRenderer.invoke('installer:defaults')
  },
  installerChooseDir() {
    return ipcRenderer.invoke('installer:choose-dir')
  },
  installerStart(target) {
    return ipcRenderer.invoke('installer:start', target)
  },
  installerLogTail() {
    return ipcRenderer.invoke('installer:log-tail')
  },
  installerFinish(launch) {
    return ipcRenderer.invoke('installer:finish', launch)
  },
  installerCancel() {
    return ipcRenderer.invoke('installer:cancel')
  },
})