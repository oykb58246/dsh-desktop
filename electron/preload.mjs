import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshDesktop', {
  onStatus(callback) {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('status', listener)
    return () => ipcRenderer.removeListener('status', listener)
  },
  windowAction(action) {
    ipcRenderer.send('window-action', action)
  },
  /** Read the persisted import configuration (sessions root + target root). */
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
  /** Choose (and persist) the Harness target directory. */
  chooseTarget() {
    return ipcRenderer.invoke('codex-import-choose-target')
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