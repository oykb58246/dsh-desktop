// Drive the tools.html UI against the E2E fake main process: patch the
// source-scan API to skip the real dialog, run through step 2, click
// "自定义会话目录", verify the directory line/badge update and session
// lists refresh; then "恢复默认" and verify it flips back.
const port = process.argv[2] ?? '9339'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target')

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
  try {
  document.getElementById('choose-source').click()
  await new Promise(r => setTimeout(r, 250))
  const input = document.querySelector('.project-item input')
  input.checked = true
  input.dispatchEvent(new Event('change'))
  await new Promise(r => setTimeout(r, 150))
  document.getElementById('to-step-2').click()
  await new Promise(r => setTimeout(r, 700))

  const read = () => ({
    step2Visible: !document.getElementById('panel-sessions').hidden,
    dirPath: document.getElementById('sessions-dir-path').textContent,
    badge: document.getElementById('sessions-dir-badge').textContent,
    badgeClass: document.getElementById('sessions-dir-badge').className,
    resetDisabled: document.getElementById('reset-sessions-dir').disabled,
    hint: document.getElementById('sessions-dir-hint').textContent,
    groups: document.querySelectorAll('.session-group').length,
    rows: document.querySelectorAll('.session-item').length,
    firstRowTitle: document.querySelector('.session-item strong')?.textContent ?? '(none)',
  })

  const before = read()
  // Click 自定义会话目录 (fake main returns D:\custom-test-sessions)
  document.getElementById('choose-sessions-dir').click()
  await new Promise(r => setTimeout(r, 900))
  const afterCustom = read()
  // Click 恢复默认
  document.getElementById('reset-sessions-dir').click()
  await new Promise(r => setTimeout(r, 900))
  const afterReset = read()
  return JSON.stringify({ before, afterCustom, afterReset })
  } catch (error) {
    return 'THREW: ' + (error?.stack ?? String(error))
  }
})()`)
console.log(result.result?.result?.value ?? JSON.stringify(result).slice(0, 600))
ws.close()
