// Verify project tick selects ALL sessions (imported ones included) and the
// import skips already-imported ones with a clear report.
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
        await new Promise(r => setTimeout(r, 1500))
        const out = {}
        // find the new-chat-5 group (contains the previously imported session)
        const groups = [...document.querySelectorAll('.project-group')]
        const target = groups.find(g => g.querySelector('.project-group__name').textContent === 'new-chat-5')
        if (!target) return 'new-chat-5 group not found'
        out.importedBadge = target.querySelector('.badge--imported')?.textContent ?? null
        // expand + tick the project
        target.querySelector('.project-group__names').dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await new Promise(r => setTimeout(r, 100))
        target.querySelector('.project-group__check').click()
        await new Promise(r => setTimeout(r, 300))
        const inputs = [...target.querySelectorAll('.session-item input')]
        out.sessionCount = inputs.length
        out.tickedCount = inputs.filter(i => i.checked).length
        out.importedTicked = [...target.querySelectorAll('.session-item.is-imported input')].every(i => i.checked)
        out.summary = document.getElementById('selection-summary').textContent
        out.runEnabled = !document.getElementById('run-import').disabled
        return JSON.stringify(out)
      })()`,
      returnByValue: true,
      awaitPromise: true,
    },
  }))
})
console.log(result.result?.result?.value ?? JSON.stringify(result).slice(0, 500))
ws.close()
