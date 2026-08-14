// Real-data check on the tools window: auto-scan listing renders, then drive
// one small project's sessions and run the one-shot import against the real
// harness (writes real session logs into DSH_HOME).
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
  await new Promise(r => setTimeout(r, 1200))
  const out = {}
  out.sessionsDir = document.getElementById('sessions-dir-path').textContent
  out.target = document.getElementById('target-path').textContent
  out.projectCount = document.querySelectorAll('.project-group').length
  out.summary = document.getElementById('selection-summary').textContent
  out.shallowBadges = [...document.querySelectorAll('.badge--warn')].length
  out.firstGroups = [...document.querySelectorAll('.project-group__name')].slice(0, 5).map(n => n.textContent)
  return JSON.stringify(out)
})()`)
console.log(result.result?.result?.value ?? JSON.stringify(result).slice(0, 600))
ws.close()
