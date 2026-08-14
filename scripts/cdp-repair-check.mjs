// Open the tools window (triggering scan + ungrouped repair), then verify the
// workspace list shows previously imported sessions grouped.
const cdpPort = process.argv[2] ?? '9351'
const harnessBase = process.argv[3] ?? 'http://127.0.0.1:60719'

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
const list = await call('workspace.list', {})
if (list.result?.ok !== true) {
  console.log('workspace.list failed:', JSON.stringify(list.result))
  process.exit(1)
}
for (const w of list.result.value.items) {
  console.log(`${w.title} | sessions: ${w.sessionIds.length} | ${w.sessionIds.join(', ')}`)
}
