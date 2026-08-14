// Click the import button with only the already-imported session selected:
// should toast a skip message and NOT re-import.
const port = process.argv[2] ?? '9351'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const page = targets.find((t) => t.url.includes('tools.html'))
if (!page) throw new Error('no tools.html target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

const result = await new Promise((resolve, reject) => {
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id === 1) resolve(msg)
  }
  ws.onerror = reject
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: `(async () => {
        await new Promise(r => setTimeout(r, 800))
        document.getElementById('run-import').click()
        await new Promise(r => setTimeout(r, 400))
        const toast = document.getElementById('toast')
        return JSON.stringify({
          toastText: toast.textContent,
          toastVisible: toast.classList.contains('is-visible'),
          progressHidden: document.getElementById('progress-box').hidden,
          doneHidden: document.getElementById('done-report').hidden,
        })
      })()`,
      returnByValue: true,
      awaitPromise: true,
    },
  }))
})
console.log(result.result?.result?.value ?? JSON.stringify(result).slice(0, 400))
ws.close()
