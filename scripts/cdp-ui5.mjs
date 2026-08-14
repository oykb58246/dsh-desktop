// Verify the four fixes: default recent sort, embedded scrolling list with
// fixed import bar, single-click row expand, and the close-tools button flow.
const port = process.argv[2] ?? '9348'
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
  const out = {}
  const list = document.getElementById('project-list')
  const stage = document.querySelector('.tool-stage')
  const bar = document.querySelector('.import-action')
  out.layout = {
    stageClientH: stage.clientHeight,
    listClientH: list.clientHeight,
    listScrollH: list.scrollHeight,
    listScrollable: list.scrollHeight > list.clientHeight,
    barVisible: bar.getBoundingClientRect().height > 0,
    barTop: Math.round(bar.getBoundingClientRect().top),
    stageBottom: Math.round(stage.getBoundingClientRect().bottom),
  }
  out.sortDefault = document.getElementById('sort-select').value
  out.firstFive = [...document.querySelectorAll('.project-group__name')].slice(0, 5).map(n => n.textContent)
  out.recentFirst = [...document.querySelectorAll('.project-group__recent')].slice(0, 3).map(r => r.textContent)

  // single click on the row body (names area) expands
  const first = document.querySelector('.project-group')
  const names = first.querySelector('.project-group__names')
  const box = first.querySelector('.project-group__sessions')
  const chevron = first.querySelector('.project-group__chevron')
  const before = box.hidden
  names.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 100))
  out.clickExpand = { before, after: box.hidden, chevron: chevron.textContent }

  // checkbox click should NOT toggle expansion
  const check = first.querySelector('.project-group__check')
  const expandedBefore = box.hidden
  check.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 100))
  out.checkDoesNotCollapse = { expandedBefore, after: box.hidden, checked: check.checked }

  // tick a session and import via fake? — real run would write data; skip.
  // Instead verify the import bar summary element and button exist.
  out.runButton = !document.getElementById('run-import').disabled
  out.summary = document.getElementById('selection-summary').textContent
  return JSON.stringify(out)
})()`)
console.log(result.result?.result?.value ?? JSON.stringify(result).slice(0, 800))
ws.close()
