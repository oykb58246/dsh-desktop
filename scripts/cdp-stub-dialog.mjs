// Stub dialog.showOpenDialog in the Electron main process via the node
// inspector target (ESM-friendly), so the tools window's "自定义会话目录"
// button can be driven end-to-end without a human picking a folder.
const port = process.argv[2] ?? '9238'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const nodeTarget = targets.find((t) => t.type === 'node')
if (!nodeTarget) throw new Error('no node inspector target')

const ws = new WebSocket(nodeTarget.webSocketDebuggerUrl)
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
        const { dialog } = await import('electron')
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: ['D:\\\\custom-test-sessions'],
        })
        return 'dialog stubbed'
      })()`,
      returnByValue: true,
      awaitPromise: true,
    },
  }))
})
const value = result.result?.result?.value
const error = result.result?.exceptionDetails?.text
console.log('main process:', value ?? `ERROR: ${error ?? JSON.stringify(result).slice(0, 300)}`)
ws.close()
