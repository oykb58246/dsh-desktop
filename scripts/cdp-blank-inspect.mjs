// Inspect the project-group DOM in the tools window: are names/paths set?
// What do computed styles say about visibility?
const port = process.argv[2] ?? '9346'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const page = targets.find((t) => t.url.includes('tools.html'))
if (!page) throw new Error('no tools.html target')

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
  await new Promise(r => setTimeout(r, 1500))
  const groups = [...document.querySelectorAll('.project-group')]
  const sample = groups.slice(0, 3).map(g => {
    const name = g.querySelector('.project-group__name')
    const pathEl = g.querySelector('.project-group__path')
    const head = g.querySelector('.project-group__head')
    const nameStyle = name ? getComputedStyle(name) : null
    return {
      nameText: name ? JSON.stringify(name.textContent) : '(missing)',
      pathText: pathEl ? JSON.stringify(pathEl.textContent.slice(0, 40)) : '(missing)',
      nameColor: nameStyle?.color,
      nameDisplay: nameStyle?.display,
      headHeight: head?.getBoundingClientRect().height,
      groupHeight: g.getBoundingClientRect().height,
      headVisible: head ? head.getBoundingClientRect().height > 0 : false,
    }
  })
  const empty = groups.filter(g => (g.querySelector('.project-group__name')?.textContent ?? '').trim() === '').length
  return JSON.stringify({
    totalGroups: groups.length,
    emptyNamedGroups: empty,
    sample,
    listScrollHeight: document.getElementById('project-list').scrollHeight,
    listClientHeight: document.getElementById('project-list').clientHeight,
  })
})()`)
console.log(result.result?.result?.value ?? JSON.stringify(result).slice(0, 800))
ws.close()
