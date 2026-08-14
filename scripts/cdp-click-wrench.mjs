// Click the wrench button in the main window, then list targets to confirm
// the tools window opened. Includes diagnostics for WS issues.
const port = process.argv[2] ?? '9336'
const timeout = (ms, label) => new Promise((_, reject) => {
  setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)
})

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
console.log('targets:', targets.map((t) => `${t.type} ${t.url.slice(0, 70)}`).join(' | '))
const page = targets.find((t) => t.type === 'page' && !t.url.includes('loading.html'))
if (!page) throw new Error('no main page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await Promise.race([
  new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = (e) => reject(new Error(`ws error: ${e.message ?? 'unknown'}`))
  }),
  timeout(8000, 'ws open'),
])

const result = await Promise.race([
  new Promise((resolve, reject) => {
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id === 1) resolve(msg)
    }
    ws.onerror = (e) => reject(new Error(`ws error: ${e.message ?? 'unknown'}`))
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `(() => {
          const btn = document.querySelector('#dsh-window-chrome button[data-action="tools"]')
          if (!btn) return 'wrench button not found'
          btn.click()
          return 'clicked'
        })()`,
        returnByValue: true,
      },
    }))
  }),
  timeout(8000, 'evaluate'),
])
console.log('click:', result.result?.result?.value ?? JSON.stringify(result).slice(0, 300))
ws.close()

await new Promise((r) => setTimeout(r, 3500))
const after = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
for (const t of after) {
  console.log('target:', t.type, t.url.slice(0, 90))
}
