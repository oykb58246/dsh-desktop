// Drive the tools-window UI to step 2 by patching the preload API with fake
// scan/rollout data, then verify the sessions-dir block renders correctly.
const port = process.argv[2] ?? '9337'
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const page = targets.find((t) => t.url.includes('tools.html'))
if (!page) throw new Error('no tools.html target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let nextId = 1
const call = (expression, awaitPromise = true) => new Promise((resolve, reject) => {
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
    params: { expression, returnByValue: true, awaitPromise },
  }))
})

// 1. Patch the bridge with fake data, then drive: choose source -> select project -> step 2
const drive = await call(`(async () => {
  const api = window.dshDesktop
  api.chooseCodexSource = async () => ({
    rootPath: 'C:\\\\fake\\\\codex-workspace',
    scannedAt: new Date().toISOString(),
    maxDepth: 5,
    projects: [{
      name: 'demo-project',
      relativePath: 'demo-project',
      absolutePath: 'C:\\\\fake\\\\codex-workspace\\\\demo-project',
      files: 12,
      sizeBytes: 4096,
      markers: ['package.json'],
    }],
  })
  api.listRollouts = async () => ([{
    id: 'fake-session-1',
    title: '测试会话',
    cwd: 'C:\\\\fake\\\\codex-workspace\\\\demo-project',
    file: 'C:\\\\fake\\\\rollout-1.jsonl',
    startedAt: '2026-08-01T08:00:00.000Z',
    model: 'codex_local_access',
  }])
  // click 选择目录 (uses patched chooseCodexSource)
  document.getElementById('choose-source').click()
  await new Promise(r => setTimeout(r, 300))
  // select the project checkbox
  const input = document.querySelector('.project-item input')
  if (input) { input.checked = true; input.dispatchEvent(new Event('change')) }
  await new Promise(r => setTimeout(r, 200))
  // click 下一步：整理会话
  const nextBtn = document.getElementById('to-step-2')
  const canNext = !nextBtn.disabled
  if (canNext) nextBtn.click()
  await new Promise(r => setTimeout(r, 600))
  const dirPath = document.getElementById('sessions-dir-path')
  const badge = document.getElementById('sessions-dir-badge')
  const resetBtn = document.getElementById('reset-sessions-dir')
  const chooseBtn = document.getElementById('choose-sessions-dir')
  return JSON.stringify({
    canNext,
    step2Visible: !document.getElementById('panel-sessions').hidden,
    sessionsDirPath: dirPath ? dirPath.textContent : '(missing)',
    sessionsDirBadge: badge ? badge.textContent : '(missing)',
    resetDisabled: resetBtn ? resetBtn.disabled : '(missing)',
    chooseBtnText: chooseBtn ? chooseBtn.textContent.trim() : '(missing)',
    sessionGroups: document.querySelectorAll('.session-group').length,
    sessionRows: document.querySelectorAll('.session-item').length,
    firstSessionTitle: document.querySelector('.session-item strong')?.textContent ?? '(none)',
  })
})()`)
console.log(drive.result?.result?.value ?? JSON.stringify(drive).slice(0, 500))
ws.close()
