// Verify the favicon reference used by loading.html/tools.html actually
// renders by inspecting the already-open tools.html target's images.
const port = process.argv[2] ?? '9333'

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const page = targets.find((t) => t.url.includes('tools.html'))
if (!page) throw new Error('no tools.html target open')

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
      expression: `JSON.stringify([...document.querySelectorAll('img')].map(img => ({
        src: img.getAttribute('src'),
        complete: img.complete,
        naturalWidth: img.naturalWidth,
      })))`,
      returnByValue: true,
    },
  }))
})
console.log('tools.html images:', result.result?.result?.value ?? JSON.stringify(result))

// Also verify the loading.html file's favicon path resolves on disk
const { existsSync } = await import('node:fs')
const { join } = await import('node:path')
const candidates = [
  join('D:/jzz/tool/dsh-desktop', 'electron', '..', 'website', 'assets', 'favicon.svg'),
  join('D:/jzz/tool/dsh-desktop', 'website', 'assets', 'favicon.svg'),
]
console.log('loading.html favicon resolves:', candidates.map((c) => `${c} -> ${existsSync(c)}`).join('\n  '))
ws.close()
