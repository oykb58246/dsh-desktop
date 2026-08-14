// Real-data UI verification: window size, stats, project rendering, search,
// and the imported-session marking against the real 526-session scan.
const port = process.argv[2] ?? '9342'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const page = targets.find((t) => t.url.includes('tools.html'))
if (!page) throw new Error('no tools.html target')

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
  await new Promise(r => setTimeout(r, 1500))
  const out = {}
  out.windowSize = { w: window.innerWidth, h: window.innerHeight }
  const text = (sel) => document.querySelector(sel)?.textContent ?? null
  out.stats = {
    projects: text('#stat-projects'), sessions: text('#stat-sessions'),
    imported: text('#stat-imported'),
  }
  out.groupCount = document.querySelectorAll('.project-group').length
  out.firstFive = [...document.querySelectorAll('.project-group__name')].slice(0, 5).map(n => n.textContent)
  out.icons = [...new Set([...document.querySelectorAll('.project-group__icon')].map(i => i.textContent))]
  out.recentSamples = [...document.querySelectorAll('.project-group__recent')].slice(0, 3).map(r => r.textContent)
  out.importedBadges = document.querySelectorAll('.badge--imported').length

  // search
  const search = document.getElementById('search-input')
  search.value = 'harness'
  search.dispatchEvent(new Event('input'))
  await new Promise(r => setTimeout(r, 200))
  out.searchHarness = [...document.querySelectorAll('.project-group__name')].map(n => n.textContent).slice(0, 8)

  // sort by sessions desc
  document.getElementById('sort-select').value = 'sessions'
  document.getElementById('sort-select').dispatchEvent(new Event('change'))
  await new Promise(r => setTimeout(r, 200))
  search.value = ''
  search.dispatchEvent(new Event('input'))
  await new Promise(r => setTimeout(r, 200))
  out.topBySessions = [...document.querySelectorAll('.project-group__name')].slice(0, 5).map(n => n.textContent)
  out.topSessionCounts = [...document.querySelectorAll('.project-group .badge--ok')].slice(0, 5).map(b => b.textContent)

  // expand a group and show its sessions
  const first = document.querySelector('.project-group')
  first.querySelector('.project-group__toggle').click()
  await new Promise(r => setTimeout(r, 100))
  out.expandedSessions = [...first.querySelectorAll('.session-item')].slice(0, 3).map(row => ({
    title: row.querySelector('strong').textContent,
    time: row.querySelector('.session-item__time').textContent,
    model: row.querySelector('.model-badge')?.textContent ?? null,
    imported: row.classList.contains('is-imported'),
  }))
  return JSON.stringify(out)
})()`)
console.log(result.result?.result?.value ?? JSON.stringify(result).slice(0, 900))
ws.close()
