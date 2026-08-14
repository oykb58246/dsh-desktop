// Capture the loading window screenshot as soon as it appears, and report
// whether the favicon images rendered.
const port = process.argv[2] ?? '9334'
const outFile = process.argv[3] ?? 'output/loading-capture.png'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let page = null
for (let i = 0; i < 60; i++) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
    page = targets.find((t) => t.type === 'page' && t.url.includes('loading.html'))
    if (page) break
  } catch {
    // CDP not up yet
  }
  await sleep(500)
}
if (!page) {
  console.log('loading.html target never appeared (already replaced by harness?)')
  process.exit(2)
}
console.log('found loading target:', page.url)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let nextId = 1
const call = (method, params) => new Promise((resolve) => {
  const id = nextId++
  const handler = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id === id) {
      ws.removeEventListener('message', handler)
      resolve(msg)
    }
  }
  ws.addEventListener('message', handler)
  ws.send(JSON.stringify({ id, method, params }))
})

// Wait for images to load
await sleep(1500)

const images = await call('Runtime.evaluate', {
  expression: `JSON.stringify([...document.querySelectorAll('img')].map(img => ({
    src: img.getAttribute('src'),
    complete: img.complete,
    naturalWidth: img.naturalWidth,
  })))`,
  returnByValue: true,
})
console.log('images:', images.result?.result?.value)

const shot = await call('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
const data = shot.result?.data
if (data) {
  writeFileSync(outFile, Buffer.from(data, 'base64'))
  console.log('screenshot saved:', outFile)
} else {
  console.log('screenshot failed:', JSON.stringify(shot).slice(0, 300))
}
ws.close()
