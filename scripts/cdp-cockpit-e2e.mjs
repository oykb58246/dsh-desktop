// Drive the upgraded cockpit-style tools page against the fake main process:
// verify stats, search filter, sort, expand/collapse, select all (imported
// sessions stay unticked), and the one-shot import + done report.
const port = process.argv[2] ?? '9339'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let nextId = 1
const call = (expression) => new Promise((resolve, reject) => {
  const id = nextId++
  const handler = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id === id) {
      ws.removeEventListener('message', handler)
      resolve(msg)
    }
  }
  ws.addEventListener('message', handler)
  ws.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true, awaitPromise: true },
  }))
})

const result = await call(`(async () => {
  await new Promise(r => setTimeout(r, 800))
  const out = {}
  const text = (sel) => document.querySelector(sel)?.textContent ?? null
  out.stats = {
    projects: text('#stat-projects'), sessions: text('#stat-sessions'),
    checkedProjects: text('#stat-checked-projects'), checkedSessions: text('#stat-checked-sessions'),
    imported: text('#stat-imported'),
  }
  out.groupCount = document.querySelectorAll('.project-group').length
  out.icons = [...document.querySelectorAll('.project-group__icon')].map(i => i.textContent)
  out.importedBadge = text('.badge--imported')
  out.recentShown = !!document.querySelector('.project-group__recent')

  // search filter
  const search = document.getElementById('search-input')
  search.value = 'library'
  search.dispatchEvent(new Event('input'))
  await new Promise(r => setTimeout(r, 150))
  out.searchGroups = [...document.querySelectorAll('.project-group__name')].map(n => n.textContent)

  // search by session title
  search.value = '修复样式'
  search.dispatchEvent(new Event('input'))
  await new Promise(r => setTimeout(r, 150))
  out.searchBySession = [...document.querySelectorAll('.project-group__name')].map(n => n.textContent)
  search.value = ''
  search.dispatchEvent(new Event('input'))
  await new Promise(r => setTimeout(r, 150))

  // expand first group, select all (project tick)
  const first = document.querySelector('.project-group')
  first.querySelector('.project-group__toggle').click()
  await new Promise(r => setTimeout(r, 100))
  out.sessionRows = first.querySelectorAll('.session-item').length
  first.querySelector('.project-group__tick input').click()
  await new Promise(r => setTimeout(r, 250))
  out.afterProjectTick = {
    checkedSessions: text('#stat-checked-sessions'),
    importedTicked: [...first.querySelectorAll('.session-item.is-imported input')].some(i => i.checked),
  }

  // global select-all
  document.getElementById('select-none').click()
  await new Promise(r => setTimeout(r, 200))
  document.getElementById('select-all').click()
  await new Promise(r => setTimeout(r, 250))
  out.afterSelectAll = {
    checkedSessions: text('#stat-checked-sessions'),
    importedTickedAnywhere: [...document.querySelectorAll('.session-item.is-imported input')].some(i => i.checked),
    summary: text('#selection-summary'),
    runEnabled: !document.getElementById('run-import').disabled,
  }

  // collapse all then expand all
  document.getElementById('collapse-all').click()
  await new Promise(r => setTimeout(r, 100))
  out.collapsedAll = [...document.querySelectorAll('.project-group__sessions')].every(b => b.hidden)
  document.getElementById('expand-all').click()
  await new Promise(r => setTimeout(r, 100))
  out.expandedAll = [...document.querySelectorAll('.project-group__sessions')].every(b => !b.hidden)

  // run import
  document.getElementById('run-import').click()
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 400))
    if (!document.getElementById('done-report').hidden) break
  }
  out.doneVisible = !document.getElementById('done-report').hidden
  out.doneCards = document.querySelectorAll('.done-card').length
  out.doneHeads = [...document.querySelectorAll('.done-card__head strong')].map(s => s.textContent)
  return JSON.stringify(out)
})()`)
console.log(result.result?.result?.value ?? JSON.stringify(result).slice(0, 800))
ws.close()
