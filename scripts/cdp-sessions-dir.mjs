// Inspect the tools window: sessions-dir block state and the IPC config.
const port = process.argv[2] ?? '9337'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const page = targets.find((t) => t.url.includes('tools.html'))
if (!page) throw new Error('no tools.html target')

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
    params: {
      expression: `(async () => {
        const dirPath = document.getElementById('sessions-dir-path')
        const badge = document.getElementById('sessions-dir-badge')
        const resetBtn = document.getElementById('reset-sessions-dir')
        const config = await window.dshDesktop.getSessionsConfig()
        return JSON.stringify({
          domPath: dirPath ? dirPath.textContent : '(block missing)',
          domBadge: badge ? badge.textContent : '(missing)',
          resetDisabled: resetBtn ? resetBtn.disabled : '(missing)',
          config,
        })
      })()`,
      returnByValue: true,
      awaitPromise: true,
    },
  }))
})
console.log(result.result?.result?.value ?? JSON.stringify(result).slice(0, 400))
ws.close()
