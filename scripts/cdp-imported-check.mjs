// Directly call the scan-all IPC from the main window and report imported
// counts, then open the tools window and re-check the stats render.
const port = process.argv[2] ?? '9343'
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

const result = await call(`(async () => {
  const scan = await window.dshDesktop.scanAll()
  const imported = scan.projects.flatMap(p => p.sessions).filter(s => s.imported)
  return JSON.stringify({
    importedCount: scan.importedCount,
    importedIds: imported.map(s => s.id),
    importedProject: imported.map(s => scan.projects.find(p => p.sessions.includes(s))?.name),
  })
})()`)
console.log(result.result?.result?.value ?? JSON.stringify(result).slice(0, 400))
ws.close()
