// CDP probe: evaluate dshDesktop sessions-config APIs in the main window.
// Usage: node scripts/cdp-probe.mjs <port> <js-expression>
const port = process.argv[2] ?? '9333'
const expression = process.argv[3] ?? 'window.dshDesktop.getSessionsConfig()'

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

const result = await new Promise((resolve, reject) => {
  const id = 1
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id === id) resolve(msg)
  }
  ws.onerror = reject
  ws.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true },
  }))
})
console.log(JSON.stringify(result.result?.result?.value ?? result, null, 2))
ws.close()
