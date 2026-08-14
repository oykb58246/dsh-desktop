// Probe the main window: wrench button present, chrome injected, harness URL.
const port = process.argv[2] ?? '9335'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const page = targets.find((t) => t.type === 'page' && !t.url.includes('loading.html'))
if (!page) throw new Error('no main page target')

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
      expression: `JSON.stringify({
        chrome: !!document.getElementById('dsh-window-chrome'),
        wrench: !!document.querySelector('#dsh-window-chrome button[data-action="tools"]'),
        wrenchSvg: !!document.querySelector('#dsh-window-chrome button[data-action="tools"] svg'),
        bodyPadding: getComputedStyle(document.body).paddingTop,
      })`,
      returnByValue: true,
    },
  }))
})
console.log('main window:', result.result?.result?.value ?? JSON.stringify(result))
ws.close()
