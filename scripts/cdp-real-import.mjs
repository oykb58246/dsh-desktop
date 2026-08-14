// Real one-shot import: tick a small real project (1 session), run import,
// report the outcome including written session paths.
const port = process.argv[2] ?? '9341'
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
  await new Promise(r => setTimeout(r, 500))
  const out = {}
  // find the small android-studio project group
  const groups = [...document.querySelectorAll('.project-group')]
  const target = groups.find(g =>
    g.querySelector('.project-group__name').textContent.includes('android-studio-gemini'))
  if (!target) return 'project not found: ' + groups.map(g => g.querySelector('.project-group__name').textContent).join(',')
  out.found = target.querySelector('.project-group__name').textContent
  out.sessionCount = target.querySelector('.badge').textContent
  // expand + tick the project (selects its session)
  target.querySelector('.project-group__toggle').click()
  await new Promise(r => setTimeout(r, 100))
  target.querySelector('.project-group__tick input').click()
  await new Promise(r => setTimeout(r, 300))
  out.summary = document.getElementById('selection-summary').textContent
  // run import
  document.getElementById('run-import').click()
  // wait for progress events and done report (copy may take a moment)
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (!document.getElementById('done-report').hidden) break
  }
  out.doneVisible = !document.getElementById('done-report').hidden
  out.progressLabel = document.getElementById('progress-label').textContent
  out.doneCards = [...document.querySelectorAll('.done-card')].map(card => card.textContent.replace(/\\s+/g, ' ').trim())
  return JSON.stringify(out)
})()`)
console.log(result.result?.result?.value ?? JSON.stringify(result).slice(0, 800))
ws.close()
