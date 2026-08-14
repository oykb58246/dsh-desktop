// Open the tools window from the main window and verify the upgraded UI
// renders the imported badge and stats against real data.
const port = process.argv[2] ?? '9345'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const page = targets.find((t) => t.type === 'page' && !t.url.includes('tools.html'))
if (!page) throw new Error('no main page target')

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

// Click the wrench to open the tools window
const clicked = await call(`(() => {
  const btn = document.querySelector('#dsh-window-chrome button[data-action="tools"]')
  if (!btn) return 'no wrench'
  btn.click()
  return 'clicked'
})()`)
console.log('wrench:', clicked.result?.result?.value)
ws.close()

await new Promise((r) => setTimeout(r, 3000))
const after = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const toolsPage = after.find((t) => t.url.includes('tools.html'))
if (!toolsPage) throw new Error('tools window did not open')

const ws2 = new WebSocket(toolsPage.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws2.onopen = resolve
  ws2.onerror = reject
})
const result = await new Promise((resolve, reject) => {
  ws2.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id === 1) resolve(msg)
  }
  ws2.onerror = reject
  ws2.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: `(async () => {
        await new Promise(r => setTimeout(r, 1500))
        const text = (sel) => document.querySelector(sel)?.textContent ?? null
        return JSON.stringify({
          windowSize: { w: window.innerWidth, h: window.innerHeight },
          stats: { imported: text('#stat-imported'), projects: text('#stat-projects') },
          importedBadges: document.querySelectorAll('.badge--imported').length,
          importedBadgeText: document.querySelector('.badge--imported')?.textContent ?? null,
        })
      })()`,
      returnByValue: true,
      awaitPromise: true,
    },
  }))
})
console.log('tools window:', result.result?.result?.value ?? JSON.stringify(result).slice(0, 300))
ws2.close()
