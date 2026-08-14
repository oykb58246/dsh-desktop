// Dump the computed styles that could collapse a .project-group to 1.33px.
const port = process.argv[2] ?? '9346'
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
      expression: `(() => {
        const g = document.querySelector('.project-group')
        if (!g) return 'no group'
        const s = getComputedStyle(g)
        const keys = ['display','height','minHeight','maxHeight','overflow','position','float','zoom','transform','contain','contentVisibility','lineHeight','fontSize','flex','flexGrow','flexShrink','flexBasis','boxSizing']
        const out = {}
        for (const k of keys) out[k] = s.getPropertyValue(k)
        const head = g.querySelector('.project-group__head')
        const hs = getComputedStyle(head)
        out.head = { display: hs.display, position: hs.position, height: hs.height, flex: hs.flex, flexShrink: hs.flexShrink, flexBasis: hs.flexBasis }
        // check for any rule setting height on project-group
        out.inlineHeight = g.style.height
        out.scrollHeight = g.scrollHeight
        out.offsetHeight = g.offsetHeight
        out.rectHeight = g.getBoundingClientRect().height
        return JSON.stringify(out)
      })()`,
      returnByValue: true,
    },
  }))
})
console.log(result.result?.result?.value ?? JSON.stringify(result).slice(0, 600))
ws.close()
