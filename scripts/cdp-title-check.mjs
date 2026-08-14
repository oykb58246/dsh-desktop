// Open the tools window (triggering scan → repair → title pinning), then
// verify the previously imported session now carries a session/title event.
const cdpPort = process.argv[2] ?? '9352'
const harnessBase = process.argv[3] ?? 'http://127.0.0.1:63039'

const targets = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json())
const page = targets.find((t) => t.type === 'page' && !t.url.includes('tools.html'))
if (!page) throw new Error('no main page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})
await new Promise((resolve) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id === 1) resolve(m)
  }
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: `(() => { const b = document.querySelector('#dsh-window-chrome button[data-action="tools"]'); if (!b) return 'no wrench'; b.click(); return 'clicked' })()`,
      returnByValue: true,
    },
  }))
})
ws.close()
await new Promise((r) => setTimeout(r, 5000))

const call = async (method, payload) => {
  const res = await fetch(`${harnessBase}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  return await res.json()
}
// Check the imported session's history for a session/title event
const history = await call('session.history', { sessionId: '019ffba8-3688-7942-b1eb-649af7b1f49c' })
if (history.result?.ok !== true) {
  console.log('history failed:', JSON.stringify(history.result))
  process.exit(1)
}
const titleEvents = history.result.value.events.filter((e) => e.event.type === 'session/title')
console.log('session/title events:', titleEvents.length)
for (const t of titleEvents) console.log(JSON.stringify(t.event.data))
