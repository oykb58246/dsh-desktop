/**
 * DSH Desktop tools workbench — browser half. Codex project import renders a
 * cockpit-style workbench: on open it auto-scans the Codex sessions directory,
 * groups rollouts by working directory into a searchable/sortable project
 * list, marks already-imported sessions, and imports the selection into the
 * Harness in one shot.
 */

const api = window.dshDesktop

// ---------- state ----------

const state = {
  config: null, // { sessions: {customRoot, defaultRoot, effectiveRoot} }
  projects: [], // [{ name, cwd, shallow, sessions: [...] }]
  importedCount: 0,
  projectChecked: new Map(), // cwd -> bool
  sessionChecked: new Map(), // cwd -> Set(sessionKey)
  search: '',
  sort: 'recent',
  running: false,
  activeTool: 'codex-import',
}

const updateState = {
  checked: false, // an explicit update:check has run at least once
  checking: false,
  downloading: false,
  info: null, // last update:info snapshot
}

const visionState = {
  loaded: false, // the persisted configuration has been read at least once
  config: null, // { enabled, apiKey, baseURL, model }
  busy: false,
}

const sessionKey = (session) => `${session.id}::${session.file}`

// ---------- dom helpers ----------

const $ = (id) => document.getElementById(id)

function showToast(message, isError = false) {
  const toast = $('toast')
  toast.textContent = message
  toast.classList.toggle('toast--error', isError)
  toast.classList.add('is-visible')
  clearTimeout(showToast._timer)
  showToast._timer = setTimeout(() => toast.classList.remove('is-visible'), 3200)
}

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', { hour12: false })
}

function formatRelative(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const delta = Date.now() - date.getTime()
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return '刚刚'
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`
  if (delta < 30 * day) return `${Math.floor(delta / day)} 天前`
  return date.toLocaleDateString('zh-CN')
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch])
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function projectIcon(project) {
  const name = project.name.toLowerCase()
  if (name.includes('rust') || project.cwd.toLowerCase().includes('rust')) return '🦀'
  if (name.includes('python') || name.includes('py')) return '🐍'
  if (name.includes('flutter') || name.includes('dart')) return '🪽'
  if (name.includes('android') || name.includes('kotlin')) return '🤖'
  if (name.includes('java')) return '☕'
  if (name.includes('js') || name.includes('node') || name.includes('web')) return '⬡'
  if (name.includes('go')) return '🐹'
  return '📁'
}

// ---------- config ----------

function renderConfig(config) {
  state.config = config
  $('sessions-dir-path').textContent = config.sessions.effectiveRoot
  const custom = config.sessions.customRoot !== null
  $('sessions-dir-badge').textContent = custom ? '自定义目录' : '自动检测'
  $('sessions-dir-badge').className = custom ? 'badge badge--warn' : 'badge badge--ok'
  $('reset-sessions-dir').disabled = !custom
}

// ---------- scan & render ----------

async function refreshAll() {
  const [config, scan] = await Promise.all([api.getImportConfig(), api.scanAll()])
  renderConfig(config)
  state.projects = scan.projects
  state.importedCount = scan.importedCount ?? 0
  state.projectChecked.clear()
  state.sessionChecked.clear()
  renderProjects()
  updateSummary()
}

function visibleProjects() {
  const query = state.search.trim().toLowerCase()
  let projects = state.projects
  if (query !== '') {
    projects = projects.filter((project) => {
      if (project.name.toLowerCase().includes(query)) return true
      if (project.cwd.toLowerCase().includes(query)) return true
      return project.sessions.some((s) => (s.title || s.id || '').toLowerCase().includes(query))
    })
  }
  const sorted = [...projects]
  if (state.sort === 'name') {
    sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  } else if (state.sort === 'sessions') {
    sorted.sort((a, b) => b.sessions.length - a.sessions.length)
  } else if (state.sort === 'recent') {
    sorted.sort((a, b) => latestTime(b) - latestTime(a))
  }
  return sorted
}

function latestTime(project) {
  let latest = 0
  for (const session of project.sessions) {
    const time = Date.parse(session.startedAt ?? '')
    if (!Number.isNaN(time) && time > latest) latest = time
  }
  return latest
}

function renderProjects() {
  const list = $('project-list')
  const projects = visibleProjects()
  if (state.projects.length === 0) {
    list.innerHTML = '<div class="empty-note">未在会话目录中发现任何 Codex 会话</div>'
    return
  }
  if (projects.length === 0) {
    list.innerHTML = '<div class="empty-note">没有匹配搜索条件的项目或会话</div>'
    return
  }
  list.innerHTML = ''
  for (const project of projects) {
    const group = document.createElement('div')
    group.className = 'project-group'
    const shallowBadge = project.shallow
      ? '<span class="badge badge--warn" title="该目录层级过浅（如用户主目录），只导入会话，不注册工作区">仅会话</span>'
      : ''
    const importedInGroup = project.sessions.filter((s) => s.imported).length
    const importedBadge = importedInGroup > 0
      ? `<span class="badge badge--muted" title="其中 ${importedInGroup} 个会话已导入过">已导入 ${importedInGroup}</span>`
      : ''
    group.innerHTML = `
      <div class="project-group__head">
        <input class="project-group__check" type="checkbox" />
        <span class="project-group__icon">${projectIcon(project)}</span>
        <span class="project-group__names">
          <span class="project-group__name"></span>
          <span class="project-group__path"></span>
        </span>
        <span class="badge badge--ok">${project.sessions.length} 个会话</span>
        ${importedBadge}
        ${shallowBadge}
        <span class="project-group__recent"></span>
        <span class="project-group__chevron" aria-hidden="true">▸</span>
      </div>
      <div class="project-group__sessions" hidden></div>`
    group.querySelector('.project-group__name').textContent = project.name
    group.querySelector('.project-group__path').textContent = project.cwd
    const recent = latestTime(project)
    group.querySelector('.project-group__recent').textContent = recent > 0 ? `最近 ${formatRelative(recent)}` : ''
    const checkbox = group.querySelector('.project-group__check')
    const chevron = group.querySelector('.project-group__chevron')
    const head = group.querySelector('.project-group__head')
    const sessionsBox = group.querySelector('.project-group__sessions')

    // A single click anywhere on the row (except the checkbox) expands or
    // collapses the session list; the checkbox keeps tick/untick semantics.
    head.addEventListener('click', (event) => {
      if (event.target.closest('.project-group__check')) return
      const hidden = sessionsBox.hidden
      sessionsBox.hidden = !hidden
      chevron.textContent = hidden ? '▾' : '▸'
    })

    const sessionSet = state.sessionChecked.get(project.cwd) ?? new Set()
    state.sessionChecked.set(project.cwd, sessionSet)
    const query = state.search.trim().toLowerCase()
    const visibleSessions = query === ''
      ? project.sessions
      : project.sessions.filter((s) => (s.title || s.id || '').toLowerCase().includes(query))
    for (const session of visibleSessions) {
      const key = sessionKey(session)
      const row = document.createElement('label')
      row.className = 'session-item'
      if (session.imported) row.classList.add('is-imported')
      row.innerHTML = `
        <input type="checkbox" />
        <span class="session-item__icon">💬</span>
        <span class="session-item__copy">
          <strong></strong>
          <small></small>
        </span>
        ${session.model ? `<span class="badge badge--muted model-badge"></span>` : ''}
        ${session.imported ? '<span class="badge badge--imported">已导入</span>' : ''}
        <span class="session-item__time"></span>`
      row.querySelector('strong').textContent = session.title || session.id || '未命名会话'
      row.querySelector('small').textContent = session.id ?? ''
      const modelBadge = row.querySelector('.model-badge')
      if (modelBadge) modelBadge.textContent = session.model
      row.querySelector('.session-item__time').textContent = formatRelative(session.startedAt)
      const input = row.querySelector('input')
      // Nothing is pre-selected: ticking is the user's explicit choice.
      if (session.imported) sessionSet.delete(key)
      const applySession = () => {
        if (input.checked) sessionSet.add(key)
        else sessionSet.delete(key)
        if (!input.checked && checkbox.checked) {
          checkbox.checked = false
          state.projectChecked.delete(project.cwd)
        }
        updateSummary()
      }
      input.addEventListener('change', applySession)
      sessionsBox.appendChild(row)
    }

    // Project checkbox reflects all its sessions being checked.
    checkbox.checked = visibleSessions.length > 0 && visibleSessions.every((s) => sessionSet.has(sessionKey(s)))
    checkbox.addEventListener('change', () => {
      const checked = checkbox.checked
      if (checked) state.projectChecked.set(project.cwd, true)
      else state.projectChecked.delete(project.cwd)
      // Project tick selects EVERY session, imported ones included: the
      // import step skips already-imported sessions and reports the skip.
      for (const row of sessionsBox.querySelectorAll('.session-item')) {
        const input = row.querySelector('input')
        input.checked = checked
        input.dispatchEvent(new Event('change'))
      }
      updateSummary()
    })
    list.appendChild(group)
  }
  updateSummary()
}

function updateSummary() {
  const projectCount = state.projectChecked.size
  let sessionCount = 0
  for (const set of state.sessionChecked.values()) sessionCount += set.size
  const totalProjects = state.projects.length
  const totalSessions = state.projects.reduce((n, p) => n + p.sessions.length, 0)
  $('stat-projects').textContent = String(totalProjects)
  $('stat-sessions').textContent = String(totalSessions)
  $('stat-checked-projects').textContent = String(projectCount)
  $('stat-checked-sessions').textContent = String(sessionCount)
  $('stat-imported').textContent = String(state.importedCount)
  $('selection-summary').textContent = sessionCount === 0
    ? '未选择任何内容'
    : `已选 ${projectCount} 个项目 · ${sessionCount} 个会话`
  $('run-import').disabled = sessionCount === 0 || state.running
}

function setAllChecked(checked) {
  for (const project of state.projects) {
    if (checked) state.projectChecked.set(project.cwd, true)
    else state.projectChecked.delete(project.cwd)
    const set = state.sessionChecked.get(project.cwd) ?? new Set()
    state.sessionChecked.set(project.cwd, set)
    set.clear()
    if (checked) {
      for (const session of project.sessions) set.add(sessionKey(session))
    }
  }
  renderProjects()
}

function setAllExpanded(expanded) {
  for (const group of document.querySelectorAll('.project-group')) {
    const box = group.querySelector('.project-group__sessions')
    const chevron = group.querySelector('.project-group__chevron')
    box.hidden = !expanded
    chevron.textContent = expanded ? '▾' : '▸'
  }
}

// ---------- one-shot import ----------

async function runImport() {
  if (state.running) return
  const selection = []
  let skippedImported = 0
  for (const project of state.projects) {
    const set = state.sessionChecked.get(project.cwd)
    if (!set || set.size === 0) continue
    const rollouts = project.sessions.filter((s) => {
      if (!set.has(sessionKey(s))) return false
      // Already-imported sessions are never re-imported: re-running the
      // conversion would overwrite a log the harness may have appended to.
      if (s.imported) {
        skippedImported += 1
        return false
      }
      return true
    })
    if (rollouts.length === 0) continue
    selection.push({
      name: project.name,
      cwd: project.cwd,
      shallow: project.shallow,
      rollouts,
    })
  }
  if (selection.length === 0) {
    showToast(skippedImported > 0
      ? `所选会话均已导入过，无需重复导入（${skippedImported} 个已跳过）`
      : '未选择任何会话')
    return
  }

  state.running = true
  $('run-import').disabled = true
  $('progress-box').hidden = false
  $('done-report').hidden = true
  setProgress(0, '开始导入…', '')
  if (skippedImported > 0) {
    showToast(`已跳过 ${skippedImported} 个已导入过的会话`, false)
  }

  try {
    const results = await api.runImport(selection)
    renderDone(results, skippedImported)
    await refreshAll()
  } catch (error) {
    showToast(`导入失败：${error.message ?? String(error)}`, true)
    setProgress(0, '导入失败', String(error.message ?? error))
  } finally {
    state.running = false
    $('run-import').disabled = true
  }
}

function setProgress(percent, label, detail) {
  $('progress-fill').style.width = `${Math.max(0, Math.min(100, percent))}%`
  $('progress-label').textContent = label
  $('progress-detail').textContent = detail
}

function renderDone(results, skippedImported = 0) {
  const box = $('done-report')
  box.hidden = false
  box.innerHTML = '<p class="section-label">IMPORT COMPLETE</p>'
  if (skippedImported > 0) {
    const skipNote = document.createElement('div')
    skipNote.className = 'done-card'
    skipNote.innerHTML = `<div class="done-card__head"><strong>已跳过</strong><span class="badge badge--muted">${skippedImported} 个</span></div>
      <div class="done-card__line">所选会话中已有 ${skippedImported} 个导入过，本次未重复写入（保留 Harness 中可能新增的对话）。</div>`
    box.appendChild(skipNote)
  }
  for (const result of results) {
    const card = document.createElement('div')
    card.className = 'done-card'
    const workspaceText = result.workspace === null
      ? '仅会话（目录层级过浅，未注册工作区）'
      : result.workspace.ok
        ? `已引用原始目录注册${result.workspace.attached > 0 ? `，${result.workspace.attached} 个会话已归组` : ''}`
        : `<span style="color:#f09aa6">${escapeHtml(result.workspace.error)}</span>`
    card.innerHTML = `
      <div class="done-card__head"><strong></strong><span class="badge badge--ok">完成</span></div>
      <div class="done-card__line"><b>项目：</b><span></span></div>
      <div class="done-card__line"><b>原始目录：</b><span></span></div>
      <div class="done-card__line"><b>会话：</b><span></span></div>
      <div class="done-card__line"><b>工作区：</b><span></span></div>`
    card.querySelector('strong').textContent = result.name
    card.querySelectorAll('.done-card__line span')[0].textContent = result.cwd
    card.querySelectorAll('.done-card__line span')[1].textContent =
      `${result.written.length} 个写入，${result.skipped.length} 个跳过`
    card.querySelectorAll('.done-card__line span')[2].textContent = workspaceText
    box.appendChild(card)
  }
  const hint = document.createElement('div')
  hint.className = 'done-card'
  hint.innerHTML = `<div class="done-card__head"><strong>下一步</strong></div>
    <div class="done-card__line">在主窗口刷新页面后，侧边栏会话列表与工作区将出现导入的会话。打开会话即可浏览迁移的历史对话。</div>`
  box.appendChild(hint)

  const closeCard = document.createElement('div')
  closeCard.className = 'done-card'
  closeCard.innerHTML = `<button class="button button--primary button--wide" id="close-tools" type="button">关闭工具区，回到主界面</button>`
  box.appendChild(closeCard)
  $('progress-box').hidden = true
  setProgress(100, '导入完成', '')
  $('close-tools').addEventListener('click', () => api.windowAction('close'))
}

// ---------- tool switching ----------

function switchTool(name) {
  state.activeTool = name
  for (const item of document.querySelectorAll('.tool-rail__item')) {
    item.classList.toggle('is-active', item.dataset.tool === name)
  }
  for (const stage of document.querySelectorAll('.tool-stage')) {
    stage.hidden = stage.id !== name
  }
  if (name === 'update-check') {
    void api.updateInfo().then((info) => {
      renderUpdateInfo(info)
      // First open of the panel triggers one automatic baseline check.
      if (!updateState.checked) return runUpdateCheck()
    }).catch(() => {})
  }
  if (name === 'vision-plugin') {
    void refreshVisionConfig()
  }
  if (name === 'archive-manage') {
    void refreshArchive()
  }
  if (name === 'remote-control') {
    void refreshRemote()
  }
}

// ---------- update check panel ----------

function setUpdateStatus(kind, text) {
  const box = $('update-status')
  box.className = `update-status update-status--${kind}`
  box.textContent = text
}

function setUpdateProgress(percent, label, detail) {
  $('update-progress-fill').style.width = `${Math.max(0, Math.min(100, percent))}%`
  $('update-progress-label').textContent = label
  $('update-progress-detail').textContent = detail
}

function latestMeta(latest) {
  const parts = [latest.sourceLabel]
  if (latest.releaseDate) parts.push(formatDate(latest.releaseDate))
  if (latest.size) parts.push(formatBytes(latest.size))
  return parts.join(' · ')
}

function renderUpdateInfo(info) {
  updateState.info = info
  $('update-current-version').textContent = `v${info.current}`
  $('update-current-meta').textContent = info.installed
    ? `已安装 · ${info.installDir ?? ''}`
    : '开发模式（未打包运行）'

  const kernelBundled = info.kernel?.bundled ?? null
  $('update-kernel-version').textContent = kernelBundled ?? '—'
  if (info.kernel?.latest) {
    $('update-kernel-meta').textContent = kernelBundled === info.kernel.latest
      ? '与 npm 最新一致'
      : `官方 npm 最新 ${info.kernel.latest}`
  } else if (kernelBundled === null) {
    $('update-kernel-meta').textContent = '未检测到内核'
  } else {
    $('update-kernel-meta').textContent = 'npm 信息不可用'
  }

  const latest = info.latest
  if (latest === null && info.checkedAt === null && (info.error ?? null) === null) {
    $('update-latest-version').textContent = '—'
    $('update-latest-meta').textContent = '尚未检查'
    setUpdateStatus('checking', '窗口打开后会自动检查，也可以点击「检查更新」。')
  } else if (latest === null && updateState.checking) {
    // A baseline check is in flight: the snapshot's checkedAt is already
    // stamped but latest is not filled yet — say so instead of misreading the
    // missing baseline as "not published".
    $('update-latest-version').textContent = '—'
    $('update-latest-meta').textContent = '正在检查'
    setUpdateStatus('checking', '正在检查官方基线…')
  } else if (info.error && latest === null) {
    $('update-latest-version').textContent = '—'
    $('update-latest-meta').textContent = '检查失败'
    setUpdateStatus('error', `检查更新失败：${info.error}`)
  } else if (latest === null) {
    $('update-latest-version').textContent = '暂无'
    $('update-latest-meta').textContent = '官方仓库尚未发布基线'
    setUpdateStatus('warn', `官方仓库（${info.repo}）还没有可用的版本基线。构建产物推送到仓库后即可在此一键更新。`)
  } else if (info.updateAvailable !== true) {
    $('update-latest-version').textContent = `v${latest.version}`
    $('update-latest-meta').textContent = latestMeta(latest)
    setUpdateStatus('ok', `已是最新版本：当前 v${info.current}，与官方基线 v${latest.version} 一致。如需重装当前版本，可点击「强制覆盖更新」。`)
  } else {
    $('update-latest-version').textContent = `v${latest.version}`
    $('update-latest-meta').textContent = latestMeta(latest)
    setUpdateStatus('available', `发现新版本 v${latest.version}（当前 v${info.current}）。`)
  }

  const downloaded = info.downloaded
  if (info.downloading === true) {
    // A download is in flight (possibly started before this panel opened):
    // show the progress box with neutral defaults — live progress events
    // overwrite them as they arrive.
    $('update-progress-box').hidden = false
    setUpdateProgress(0, '正在下载官方更新包…', '等待下载进度…')
    $('update-now').hidden = true
    $('update-apply').hidden = true
    $('update-cancel').hidden = false
  } else if (downloaded?.ready === true) {
    $('update-progress-box').hidden = false
    setUpdateProgress(100, '更新包已就绪',
      `已下载 ${formatBytes(downloaded.size)}${
        downloaded.sha512Ok === true ? ' · sha512 校验通过'
          : downloaded.sha512Ok === null ? ' · 官方基线未提供 sha512（未校验）' : ''}`)
    $('update-now').hidden = true
    $('update-apply').hidden = !info.installed
    $('update-cancel').hidden = true
    setUpdateStatus('available', info.installed
      ? '更新包已就绪，点击「重启并更新」完成更新。'
      : '更新包已就绪。开发模式无法自动更新，请使用安装版。')
  } else {
    $('update-progress-box').hidden = true
    $('update-cancel').hidden = true
    $('update-apply').hidden = true
    // The download button doubles as the force-reinstall entry: visible
    // whenever a baseline exists, relabeled when the version already matches.
    $('update-now').hidden = latest === null || info.downloading === true
    $('update-now').innerHTML = info.updateAvailable === true
      ? '立即更新 <span>→</span>'
      : '强制覆盖更新 <span>→</span>'
    if (info.downloadError) setUpdateStatus('error', `下载失败：${info.downloadError}`)
  }

  document.querySelector('.tool-rail__item[data-tool="update-check"]')
    ?.classList.toggle('has-update', info.updateAvailable === true)
}

async function runUpdateCheck() {
  if (updateState.checking) return
  updateState.checking = true
  updateState.checked = true
  setUpdateStatus('checking', '正在对照官方仓库基线…')
  $('update-check-now').disabled = true
  try {
    const info = await api.updateCheck()
    renderUpdateInfo(info)
  } catch (error) {
    setUpdateStatus('error', `检查更新失败：${error.message ?? String(error)}`)
  } finally {
    updateState.checking = false
    $('update-check-now').disabled = false
  }
}

async function startDownload() {
  if (updateState.downloading) return
  updateState.downloading = true
  setUpdateStatus('checking', '开始下载官方更新包…')
  $('update-progress-box').hidden = false
  setUpdateProgress(0, '正在下载…', '')
  try {
    const info = await api.updateDownload()
    updateState.downloading = false
    renderUpdateInfo(info)
    if (info.downloadError) showToast(`下载失败：${info.downloadError}`, true)
  } catch (error) {
    updateState.downloading = false
    showToast(`下载失败：${error.message ?? String(error)}`, true)
    try { renderUpdateInfo(await api.updateInfo()) } catch { /* keep current view */ }
  }
}

async function cancelDownload() {
  try {
    const info = await api.updateCancel()
    renderUpdateInfo(info)
    showToast('已取消下载')
  } catch { /* cancel is best-effort */ }
}

async function applyUpdateNow() {
  if (updateState.info?.downloaded?.ready !== true) return
  setUpdateStatus('checking', '正在启动更新程序并退出当前应用…（如弹出 UAC 授权窗口，请选择「是」）')
  try {
    await api.updateApply()
  } catch (error) {
    showToast(`启动更新失败：${error.message ?? String(error)}`, true)
    try { renderUpdateInfo(await api.updateInfo()) } catch { /* keep current view */ }
  }
}

// ---------- vision plugin panel ----------

/** Read the persisted vision configuration into the panel (first open). */
async function refreshVisionConfig() {
  if (visionState.busy) return
  try {
    const config = await api.visionGetConfig()
    visionState.config = config
    visionState.loaded = true
    renderVisionConfig()
  } catch (error) {
    showToast(`读取视觉插件配置失败：${error.message ?? String(error)}`, true)
  }
}

function renderVisionConfig() {
  const config = visionState.config
  if (config === null) return
  $('vision-enabled').checked = config.enabled !== false
  $('vision-status').textContent = config.enabled === false ? '已关闭' : '已开启'
  $('vision-status').classList.toggle('is-off', config.enabled === false)
  $('vision-apikey').value = config.apiKey ?? ''
  $('vision-baseurl').value = config.baseURL ?? ''
  const model = config.model ?? 'qwen-vl-max'
  $('vision-model').value = model
  $('vision-model-name').textContent = model || '—'
}

async function saveVisionConfig() {
  if (visionState.busy) return
  visionState.busy = true
  $('vision-save').disabled = true
  try {
    const next = {
      enabled: $('vision-enabled').checked,
      apiKey: $('vision-apikey').value.trim(),
      baseURL: $('vision-baseurl').value.trim(),
      model: $('vision-model').value.trim(),
    }
    visionState.config = await api.visionSetConfig(next)
    renderVisionConfig()
    showToast('视觉插件配置已保存并即时生效。')
  } catch (error) {
    showToast(`保存视觉插件配置失败：${error.message ?? String(error)}`, true)
  } finally {
    visionState.busy = false
    $('vision-save').disabled = false
  }
}

async function runVisionTest() {
  const status = $('vision-test-status')
  const button = $('vision-test')
  button.disabled = true
  status.textContent = '测试中…'
  status.className = 'vision-test-status'
  try {
    const result = await api.visionTest({
      apiKey: $('vision-apikey').value.trim(),
      baseURL: $('vision-baseurl').value.trim(),
      model: $('vision-model').value.trim(),
    })
    status.textContent = result.ok ? result.message : `失败：${result.message}`
    status.className = result.ok ? 'vision-test-status vision-test-status--ok' : 'vision-test-status vision-test-status--fail'
  } catch (error) {
    status.textContent = `测试出错：${error.message ?? String(error)}`
    status.className = 'vision-test-status vision-test-status--fail'
  } finally {
    button.disabled = false
  }
}

function wireVisionPanel() {
  $('vision-save').addEventListener('click', () => { void saveVisionConfig() })
  $('vision-test').addEventListener('click', () => { void runVisionTest() })
  $('vision-enabled').addEventListener('change', renderVisionConfig)
  // Open attribution links in the system browser rather than inside the workbench.
  for (const link of document.querySelectorAll('.vision-link')) {
    link.addEventListener('click', (event) => {
      event.preventDefault()
      if (link.dataset.href) void api.openExternal(link.dataset.href)
    })
  }
}

// ---------- archive management panel ----------

const archiveState = {
  busy: false,
}

/** Read archived workspaces + sessions from the harness and render the panel. */
async function refreshArchive() {
  if (archiveState.busy) return
  archiveState.busy = true
  try {
    const data = await api.archiveList()
    renderArchive(data)
  } catch (error) {
    renderArchive({ workspaces: [], sessions: [] })
    showToast(`读取归档列表失败：${error.message ?? String(error)}`, true)
  } finally {
    archiveState.busy = false
  }
}

function renderArchive(data) {
  const workspaces = data.workspaces ?? []
  const sessions = data.sessions ?? []
  const wsBox = $('archive-workspaces')
  const ssBox = $('archive-sessions')
  if (workspaces.length === 0) {
    wsBox.innerHTML = '<div class="empty-note">暂无已归档的工作区</div>'
  } else {
    wsBox.innerHTML = ''
    for (const workspace of workspaces) {
      const row = document.createElement('div')
      row.className = 'archive-item'
      const count = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0
      row.innerHTML = `
        <span class="archive-item__copy">
          <span class="archive-item__title"></span>
          <span class="archive-item__meta"></span>
        </span>
        <button class="button button--secondary button--mini" type="button">恢复</button>`
      row.querySelector('.archive-item__title').textContent = workspace.title || workspace.workspaceId
      row.querySelector('.archive-item__meta').textContent = `${workspace.path} · ${count} 个会话`
      row.querySelector('button').addEventListener('click', () => {
        void restoreWorkspace(workspace.workspaceId)
      })
      wsBox.appendChild(row)
    }
  }
  if (sessions.length === 0) {
    ssBox.innerHTML = '<div class="empty-note">暂无单独归档的会话</div>'
  } else {
    ssBox.innerHTML = ''
    for (const session of sessions) {
      const row = document.createElement('div')
      row.className = 'archive-item'
      row.innerHTML = `
        <span class="archive-item__copy">
          <span class="archive-item__title"></span>
          <span class="archive-item__meta"></span>
        </span>
        <button class="button button--secondary button--mini" type="button">恢复</button>`
      row.querySelector('.archive-item__title').textContent = session.title ?? session.sessionId
      row.querySelector('.archive-item__meta').textContent = session.sessionId
      row.querySelector('button').addEventListener('click', () => {
        void restoreSession(session.sessionId)
      })
      ssBox.appendChild(row)
    }
  }
}

async function restoreWorkspace(workspaceId) {
  if (archiveState.busy) return
  archiveState.busy = true
  try {
    await api.archiveRestoreWorkspace(workspaceId)
    showToast('已恢复工作区')
  } catch (error) {
    showToast(`恢复失败：${error.message ?? String(error)}`, true)
  } finally {
    archiveState.busy = false
  }
  await refreshArchive()
}

async function restoreSession(sessionId) {
  if (archiveState.busy) return
  archiveState.busy = true
  try {
    await api.archiveRestoreSession(sessionId)
    showToast('已恢复会话')
  } catch (error) {
    showToast(`恢复失败：${error.message ?? String(error)}`, true)
  } finally {
    archiveState.busy = false
  }
  await refreshArchive()
}

function wireArchivePanel() {
  $('archive-refresh').addEventListener('click', () => { void refreshArchive() })
}

// ---------- web remote control panel ----------

const remoteState = {
  snapshot: null, // last snapshot from the main process
  busy: false,
}

function setRemoteStatus(kind, text) {
  const box = $('remote-status')
  box.className = `update-status update-status--${kind}`
  box.textContent = text
}

/** Render one link row (URL + copy + QR toggle) into a links container. */
function renderLinkRow(box, url) {
  const row = document.createElement('div')
  row.className = 'remote-link-row'
  row.innerHTML = `
    <code class="remote-link-url"></code>
    <button class="button button--secondary button--mini" type="button" data-copy>复制</button>
    <button class="button button--secondary button--mini" type="button" data-qr>二维码</button>
    <div class="remote-qr" hidden></div>`
  row.querySelector('.remote-link-url').textContent = url
  row.querySelector('[data-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url)
      showToast('链接已复制，可发送到手机')
    } catch {
      showToast('复制失败，请直接选择链接文本', true)
    }
  })
  const qrBox = row.querySelector('.remote-qr')
  row.querySelector('[data-qr]').addEventListener('click', async () => {
    if (qrBox.hidden === false) {
      qrBox.hidden = true
      return
    }
    qrBox.hidden = false
    qrBox.textContent = '生成中…'
    try {
      const svg = await api.remoteQr(url)
      if (typeof svg === 'string' && svg !== '') qrBox.innerHTML = svg
      else throw new Error('empty svg')
    } catch {
      qrBox.hidden = true
      showToast('二维码生成失败，请使用复制链接', true)
    }
  })
  box.appendChild(row)
}

/** Render one remote-control snapshot into the panel. */
function renderRemote(snapshot) {
  if (snapshot === null) return
  remoteState.snapshot = snapshot
  $('remote-lan-enabled').checked = snapshot.lanEnabled === true
  $('remote-public-enabled').checked = snapshot.publicEnabled === true
  $('remote-token').textContent = snapshot.token
  $('remote-port').value = String(snapshot.port)

  const lanBox = $('remote-lan-links')
  lanBox.innerHTML = ''
  if (snapshot.lanEnabled === true) {
    lanBox.hidden = false
    for (const url of snapshot.lanUrls ?? []) renderLinkRow(lanBox, `${url}/?token=${snapshot.token}`)
  } else {
    lanBox.hidden = true
  }

  const pubBox = $('remote-public-links')
  pubBox.innerHTML = ''
  if (snapshot.publicEnabled === true) {
    pubBox.hidden = false
    if (snapshot.publicUrl !== null) {
      renderLinkRow(pubBox, `${snapshot.publicUrl}/?token=${snapshot.token}`)
    } else {
      pubBox.innerHTML = '<div class="empty-note">正在建立公网隧道…（通常需要十几秒，可点击「刷新链接」查看最新状态）</div>'
    }
  } else {
    pubBox.hidden = true
  }

  const problems = []
  if (snapshot.proxyError) problems.push(`局域网服务异常：${snapshot.proxyError}`)
  if (snapshot.tunnelError) problems.push(`公网隧道异常：${snapshot.tunnelError}`)
  if (snapshot.harnessReady !== true) problems.push('DSH 服务尚未就绪，请稍后重试')
  if (snapshot.lanEnabled === true && (snapshot.lanAddresses ?? []).length === 0) {
    problems.push('未检测到局域网地址（电脑可能未连接网络）')
  }
  if (problems.length > 0) {
    setRemoteStatus('warn', problems.join('；'))
    return
  }
  if (snapshot.lanEnabled === true || snapshot.publicEnabled === true) {
    const channels = []
    if (snapshot.lanEnabled === true) channels.push(`局域网 :${snapshot.port}`)
    if (snapshot.publicEnabled === true) {
      channels.push(snapshot.publicUrl !== null ? '公网隧道已就绪' : '公网隧道建立中…')
    }
    setRemoteStatus('ok', `远程控制已开启（${channels.join(' · ')}）。手机访问上方链接即可，链接已内置访问令牌。`)
  } else {
    setRemoteStatus('checking', '远程控制当前关闭。开启下方任一开关后，本面板会生成手机可访问的链接。')
  }
}

async function refreshRemote() {
  if (remoteState.busy) return
  remoteState.busy = true
  try {
    renderRemote(await api.remoteGetState())
  } catch (error) {
    showToast(`读取远程控制状态失败：${error.message ?? String(error)}`, true)
  } finally {
    remoteState.busy = false
  }
}

async function toggleRemoteLan(enabled) {
  try {
    const snapshot = await api.remoteSetLan(enabled)
    if (snapshot === null) throw new Error('远程控制服务尚未就绪')
    renderRemote(snapshot)
    showToast(enabled ? '局域网访问已开启' : '局域网访问已关闭')
  } catch (error) {
    showToast(`操作失败：${error.message ?? String(error)}`, true)
    await refreshRemote()
  }
}

async function toggleRemotePublic(enabled) {
  try {
    const snapshot = await api.remoteSetPublic(enabled)
    if (snapshot === null) throw new Error('远程控制服务尚未就绪')
    renderRemote(snapshot)
    showToast(enabled ? '公网访问已开启，正在建立隧道…' : '公网访问已关闭')
  } catch (error) {
    showToast(`操作失败：${error.message ?? String(error)}`, true)
    await refreshRemote()
  }
}

async function resetRemoteToken() {
  try {
    const snapshot = await api.remoteResetToken()
    if (snapshot === null) throw new Error('远程控制服务尚未就绪')
    renderRemote(snapshot)
    showToast('令牌已重置，所有旧链接已立即失效')
  } catch (error) {
    showToast(`重置令牌失败：${error.message ?? String(error)}`, true)
  }
}

async function changeRemotePort() {
  const input = $('remote-port')
  const value = Number(input.value)
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    input.value = String(remoteState.snapshot?.port ?? '')
    showToast('端口需为 1024–65535 之间的整数', true)
    return
  }
  try {
    const snapshot = await api.remoteSetPort(value)
    if (snapshot === null) throw new Error('远程控制服务尚未就绪')
    renderRemote(snapshot)
    showToast(`端口已改为 ${snapshot.port}，链接已更新`)
  } catch (error) {
    showToast(`修改端口失败：${error.message ?? String(error)}`, true)
    await refreshRemote()
  }
}

function wireRemotePanel() {
  $('remote-lan-enabled').addEventListener('change', (event) => { void toggleRemoteLan(event.target.checked) })
  $('remote-public-enabled').addEventListener('change', (event) => { void toggleRemotePublic(event.target.checked) })
  $('remote-reset-token').addEventListener('click', () => { void resetRemoteToken() })
  $('remote-refresh').addEventListener('click', () => { void refreshRemote() })
  $('remote-port').addEventListener('change', () => { void changeRemotePort() })
  api.onRemoteState((snapshot) => renderRemote(snapshot))
}

// ---------- wiring ----------

function wireChrome() {
  for (const button of document.querySelectorAll('.tools-chrome__button')) {
    button.addEventListener('click', () => api.windowAction(button.dataset.action))
  }
}

function wireRail() {
  for (const item of document.querySelectorAll('.tool-rail__item:not(:disabled)')) {
    item.addEventListener('click', () => switchTool(item.dataset.tool))
  }
}

function wireUpdatePanel() {
  $('update-check-now').addEventListener('click', () => { void runUpdateCheck() })
  $('update-now').addEventListener('click', () => { void startDownload() })
  $('update-apply').addEventListener('click', () => { void applyUpdateNow() })
  $('update-cancel').addEventListener('click', () => { void cancelDownload() })
  $('update-open-repo').addEventListener('click', () => { void api.updateOpenRepo() })
  api.onUpdateProgress((progress) => {
    if (progress.phase === 'download') {
      const percent = typeof progress.percent === 'number' && progress.percent >= 0 ? progress.percent : 0
      setUpdateProgress(percent, '正在下载官方更新包…',
        `${formatBytes(progress.received)} / ${formatBytes(progress.total)}`)
    } else if (progress.phase === 'verify') {
      setUpdateProgress(100, '正在校验下载文件…',
        progress.sha512Ok === false ? 'sha512 校验失败'
          : progress.sha512Ok === true ? 'sha512 校验通过'
            : '官方基线未提供 sha512，跳过校验')
    }
  })
}

function wire() {
  wireChrome()
  wireRail()
  wireUpdatePanel()
  wireVisionPanel()
  wireArchivePanel()
  wireRemotePanel()
  $('refresh-scan').addEventListener('click', refreshAll)
  $('choose-sessions-dir').addEventListener('click', async () => {
    const config = await api.chooseSessionsRoot()
    if (config === null) return
    renderConfig(config)
    showToast('会话目录已更新')
    await refreshAll()
  })
  $('reset-sessions-dir').addEventListener('click', async () => {
    const config = await api.resetSessionsRoot()
    renderConfig(config)
    showToast('已恢复默认会话目录')
    await refreshAll()
  })
  $('run-import').addEventListener('click', runImport)
  $('search-input').addEventListener('input', (event) => {
    state.search = event.target.value
    renderProjects()
  })
  $('sort-select').addEventListener('change', (event) => {
    state.sort = event.target.value
    renderProjects()
  })
  $('select-all').addEventListener('click', () => setAllChecked(true))
  $('select-none').addEventListener('click', () => setAllChecked(false))
  $('expand-all').addEventListener('click', () => setAllExpanded(true))
  $('collapse-all').addEventListener('click', () => setAllExpanded(false))
  api.onImportProgress((progress) => {
    if (progress.kind === 'session-progress') {
      setProgress(
        100,
        `正在写入会话 ${progress.project}…`,
        progress.phase === 'written' ? `已写入 ${progress.logPath}` : '',
      )
    }
  })
  // The update rail badge must be visible as soon as the tools window opens,
  // not only after the update panel is opened: fetch the shared baseline
  // snapshot (the boot background check may already have filled it) and, when
  // no check has run this session yet, trigger one so the dot appears as soon
  // as the network verdict lands (renderUpdateInfo toggles `.has-update`).
  void api.updateInfo().then((info) => {
    renderUpdateInfo(info)
    if (!updateState.checked) return runUpdateCheck()
  }).catch(() => {})
  void refreshAll()
  switchTool('codex-import')
}

document.addEventListener('DOMContentLoaded', wire)
