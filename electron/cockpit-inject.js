(() => {
  if (window.__dshCockpit) return
  window.__dshCockpit = true
  const api = window.dshDesktop
  if (!api || typeof api.wsList !== 'function') return

  document.documentElement.setAttribute('data-dsh-title-bar-height', '42')

  const ICON_RIGHT = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2" width="13" height="12" rx="2.5" stroke="currentColor" stroke-width="1.5"/><rect x="10.5" y="3.25" width="2.75" height="9.5" rx="1" fill="currentColor"/></svg>'
  const ICON_BOTTOM = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2" width="13" height="12" rx="2.5" stroke="currentColor" stroke-width="1.5"/><rect x="3.25" y="10" width="9.5" height="2.75" rx="1" fill="currentColor"/></svg>'

  const state = {
    side: false,
    term: false,
    width: 420,
    height: 220,
    workspaces: [],
    root: '',
    treeRel: '',
    file: null,
  }

  const style = document.createElement('style')
  style.textContent = `
    #root { margin-right: var(--dsh-desk-side, 0px); }
    #dsh-desk-side, #dsh-desk-term {
      position: fixed; z-index: 50; color: var(--dsw-alias-label-primary, #e8eefb);
      background: var(--dsw-specific-sidebar-fill, #141a24);
      font: 13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;
    }
    #dsh-desk-side {
      top: 42px; right: 0; bottom: var(--dsh-desk-term, 0px); width: var(--dsh-desk-side, 0px);
      border-left: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08));
      display: flex; flex-direction: column; overflow: hidden;
    }
    #dsh-desk-term {
      left: 0; right: var(--dsh-desk-side, 0px); bottom: 0; height: var(--dsh-desk-term, 0px);
      border-top: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08));
      display: flex; flex-direction: column; overflow: hidden;
      font: 12.5px/1.45 Consolas,"Cascadia Mono","Microsoft YaHei",monospace;
    }
    .dsh-desk-bar { display:flex; align-items:center; gap:8px; height:34px; padding:0 10px; flex:none;
      border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08)); }
    .dsh-desk-bar button, .dsh-desk-toolbar button, .dsh-desk-eb button {
      border:0; border-radius:8px; background:transparent; color:inherit; cursor:pointer; padding:4px 8px;
    }
    .dsh-desk-eb .save { background:#4d6bfe; color:#fff; }
    .dsh-desk-toolbar { display:flex; gap:6px; padding:8px; }
    .dsh-desk-toolbar select { flex:1; min-width:0; height:28px; border-radius:8px; border:1px solid rgba(255,255,255,.12); background:transparent; color:inherit; }
    .dsh-desk-list { flex:1; overflow:auto; padding:0 6px 10px; }
    .dsh-desk-item { display:flex; gap:8px; width:100%; padding:5px 8px; border:0; border-radius:8px; background:transparent; color:inherit; text-align:left; cursor:pointer; }
    .dsh-desk-item:hover { background: rgba(255,255,255,.06); }
    .dsh-desk-editor { flex:1; min-height:0; display:flex; flex-direction:column; border-top:1px solid rgba(255,255,255,.08); }
    .dsh-desk-eb { display:flex; align-items:center; gap:8px; padding:6px 10px; }
    .dsh-desk-eb strong { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #dsh-desk-text { flex:1; border:0; resize:none; padding:10px 12px; background:transparent; color:inherit;
      font:12.5px/1.55 Consolas,"Cascadia Mono",monospace; outline:none; }
    #dsh-desk-termout { flex:1; overflow:auto; padding:8px 12px; white-space:pre-wrap; word-break:break-all; margin:0; }
    .dsh-desk-termin { display:flex; gap:8px; padding:8px 10px; border-top:1px solid rgba(255,255,255,.08); }
    .dsh-desk-termin input { flex:1; border:0; background:transparent; color:inherit; outline:none; font:inherit; }
    #dsh-window-chrome .dsh-desk-toggle { width:34px; }
    #dsh-window-chrome .dsh-desk-toggle::before, #dsh-window-chrome .dsh-desk-toggle::after { display:none; }
    #dsh-window-chrome .dsh-desk-toggle svg { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); }
    #dsh-window-chrome .dsh-desk-toggle.is-on { background:rgba(77,107,254,.28); color:#fff; }
    [class*="toggleCluster"] { display:none !important; }
  `
  document.head.appendChild(style)

  const side = document.createElement('aside')
  side.id = 'dsh-desk-side'
  side.innerHTML = `
    <div class="dsh-desk-bar"><strong>文件</strong></div>
    <div class="dsh-desk-toolbar">
      <select id="dsh-desk-ws"></select>
      <button type="button" id="dsh-desk-up">上级</button>
    </div>
    <div class="dsh-desk-list" id="dsh-desk-tree"></div>
    <div class="dsh-desk-editor" id="dsh-desk-editor" hidden>
      <div class="dsh-desk-eb">
        <strong id="dsh-desk-fname">未打开文件</strong>
        <button type="button" class="save" id="dsh-desk-save">保存</button>
      </div>
      <textarea id="dsh-desk-text" spellcheck="false"></textarea>
    </div>`
  const term = document.createElement('section')
  term.id = 'dsh-desk-term'
  term.innerHTML = `
    <div class="dsh-desk-bar">
      <strong>终端</strong>
      <small id="dsh-desk-cwd" style="opacity:.65;flex:1;overflow:hidden;text-overflow:ellipsis"></small>
      <button type="button" id="dsh-desk-termstart">启动</button>
      <button type="button" id="dsh-desk-termclear">清屏</button>
    </div>
    <pre id="dsh-desk-termout"></pre>
    <form class="dsh-desk-termin" id="dsh-desk-termform">
      <span>$</span>
      <input id="dsh-desk-termin" autocomplete="off" spellcheck="false" />
    </form>`
  document.body.appendChild(side)
  document.body.appendChild(term)

  const $ = (id) => document.getElementById(id)
  const apply = () => {
    document.documentElement.style.setProperty('--dsh-desk-side', state.side ? state.width + 'px' : '0px')
    document.documentElement.style.setProperty('--dsh-desk-term', state.term ? state.height + 'px' : '0px')
    document.querySelectorAll('#dsh-window-chrome .dsh-desk-toggle').forEach((btn) => {
      btn.classList.toggle('is-on', btn.dataset.kind === 'side' ? state.side : state.term)
    })
  }

  const mountToggles = () => {
    const bar = document.querySelector('#dsh-window-chrome .dsh-window-actions')
    if (!bar || bar.querySelector('.dsh-desk-toggle')) return
    const bottom = document.createElement('button')
    bottom.type = 'button'
    bottom.className = 'dsh-title-button dsh-desk-toggle'
    bottom.dataset.kind = 'term'
    bottom.title = '展开或收起底部终端'
    bottom.innerHTML = ICON_BOTTOM
    const right = document.createElement('button')
    right.type = 'button'
    right.className = 'dsh-title-button dsh-desk-toggle'
    right.dataset.kind = 'side'
    right.title = '展开或收起右侧文件栏'
    right.innerHTML = ICON_RIGHT
    bar.insertBefore(right, bar.firstChild)
    bar.insertBefore(bottom, bar.firstChild)
    bottom.addEventListener('click', () => {
      state.term = !state.term
      apply()
      if (state.term) void startTerm()
    })
    right.addEventListener('click', () => { state.side = !state.side; apply() })
    apply()
  }

  const renderWorkspaces = () => {
    const select = $('dsh-desk-ws')
    select.replaceChildren()
    for (const item of state.workspaces) {
      const opt = document.createElement('option')
      opt.value = item.path
      opt.textContent = item.title || item.path
      select.appendChild(opt)
    }
    if (state.root) select.value = state.root
    else if (state.workspaces[0]) {
      state.root = state.workspaces[0].path
      select.value = state.root
    }
  }

  const loadTree = async () => {
    const box = $('dsh-desk-tree')
    if (!state.root) {
      box.textContent = '还没有工作区。'
      return
    }
    const result = await api.wsTree({ root: state.root, rel: state.treeRel })
    box.replaceChildren()
    if (!result.ok) {
      box.textContent = result.error || '无法读取目录'
      return
    }
    for (const item of result.items) {
      const btn = document.createElement('button')
      btn.className = 'dsh-desk-item'
      btn.type = 'button'
      btn.textContent = (item.dir ? '📁 ' : '📄 ') + item.name
      btn.addEventListener('click', () => {
        if (item.dir) {
          state.treeRel = item.rel
          void loadTree()
        } else {
          void openFile(item.rel)
        }
      })
      box.appendChild(btn)
    }
  }

  const openAbs = async (abs) => {
    if (!abs || abs === '.') return
    state.side = true
    apply()
    const hit = state.workspaces.find((ws) => abs.toLowerCase().startsWith(String(ws.path).toLowerCase()))
    if (hit) {
      state.root = hit.path
      renderWorkspaces()
    }
    const rel = hit
      ? abs.slice(hit.path.length).replace(/^[\\/]/, '').replaceAll('\\', '/')
      : abs.replaceAll('\\', '/')
    await openFile(rel)
  }
  window.__dshDeskOpen = openAbs

  const openFile = async (rel) => {
    const result = await api.wsRead({ root: state.root, rel })
    if (!result.ok) {
      if (result.binary) { await api.wsReveal({ path: result.path }); return }
      $('dsh-desk-fname').textContent = result.error || '无法打开'
      return
    }
    state.file = { rel, path: result.path }
    $('dsh-desk-editor').hidden = false
    $('dsh-desk-fname').textContent = rel
    $('dsh-desk-text').value = result.text
  }

  const appendTerm = (text) => {
    const out = $('dsh-desk-termout')
    out.textContent += text
    out.scrollTop = out.scrollHeight
  }

  const startTerm = async () => {
    if (typeof api.termStart !== 'function') return
    const result = await api.termStart({ cwd: state.root || undefined })
    $('dsh-desk-cwd').textContent = state.root || ''
    appendTerm(result.ok ? '\n[已启动 ' + (result.shell || '') + ']\n' : '\n[启动失败]\n')
  }

  const origFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input)
    if (String(url).includes('/api/host.openPath')) {
      try {
        const raw = init && typeof init.body === 'string' ? init.body : ''
        const msg = raw ? JSON.parse(raw) : {}
        const filePath = msg.payload && msg.payload.path
        if (typeof filePath === 'string' && filePath !== '' && filePath !== '.') {
          void openAbs(filePath)
          return new Response(JSON.stringify({
            type: 'server-response',
            rpcId: msg.rpcId,
            result: { ok: true, value: { opened: true } },
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
      } catch { /* fall through */ }
    }
    return origFetch(input, init)
  }

  $('dsh-desk-ws').addEventListener('change', (event) => {
    state.root = event.target.value
    state.treeRel = ''
    void loadTree()
  })
  $('dsh-desk-up').addEventListener('click', () => {
    const parts = state.treeRel.split('/').filter(Boolean)
    parts.pop()
    state.treeRel = parts.join('/')
    void loadTree()
  })
  $('dsh-desk-save').addEventListener('click', async () => {
    if (!state.file) return
    const result = await api.wsWrite({ root: state.root, rel: state.file.rel, text: $('dsh-desk-text').value })
    $('dsh-desk-fname').textContent = result.ok ? state.file.rel + ' · 已保存' : (result.error || '保存失败')
  })
  $('dsh-desk-termstart').addEventListener('click', () => { void startTerm() })
  $('dsh-desk-termclear').addEventListener('click', () => { $('dsh-desk-termout').textContent = '' })
  $('dsh-desk-termform').addEventListener('submit', (event) => {
    event.preventDefault()
    const input = $('dsh-desk-termin')
    const line = input.value
    input.value = ''
    appendTerm('\n$ ' + line + '\n')
    void api.termWrite({ text: line + '\r\n' })
  })
  if (typeof api.onTermData === 'function') api.onTermData((payload) => appendTerm(payload.text || ''))

  mountToggles()
  new MutationObserver(mountToggles).observe(document.body, { childList: true })
  apply()
  void (async () => {
    const listed = await api.wsList()
    state.workspaces = listed.items || []
    renderWorkspaces()
    await loadTree()
  })()
})()
