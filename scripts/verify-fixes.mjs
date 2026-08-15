// Verify all fixes against the live fixture page, using the REAL injected script.
import { chromium } from 'file:///D:/jzz/tool/dsh-desktop/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs'
import { TURN_CHROME_SCRIPT } from 'file:///D:/jzz/tool/dsh-desktop/electron/turn-chrome.mjs'

const base = process.argv[2] ?? 'http://127.0.0.1:51881'
const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:\\Users\\17367\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1237\\chrome-headless-shell-win64\\chrome-headless-shell.exe',
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 400)))
await page.goto(`${base}/?fixture&v=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })

const sidebarState = {
  panelOpen: true,
  width: 400,
  activePane: 'pane:1',
  nextTerminal: 1,
  nextBrowser: 1,
  expanded: [],
  splits: { kind: 'leaf', id: 'pane:1', tabs: [{ id: 'tab:1', type: 'explorer', title: 'explorer', path: null }], active: 'tab:1' },
  bottomOpen: false,
  bottomHeight: 220,
  bottomOpenedOnce: false,
  bottomSplits: { kind: 'leaf', id: 'pane:2', tabs: [], active: null },
}
await page.evaluate((state) => {
  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'fx-alpha' }))
  localStorage.setItem('dsh-sidebar:v1:fx-alpha', JSON.stringify(state))
}, sidebarState)
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(15_000)

// 1. Panel stays closed despite persisted panelOpen:true
const panelCheck = await page.evaluate(() => {
  const panel = document.querySelector('[class*="dxPSYW_panel"]')
  return {
    panelOpen: panel ? !panel.classList.contains('dxPSYW_panelHidden') : null,
    flow: !!document.querySelector('[data-chat-flow]'),
  }
})
console.log('=== 1. panel after restore (patched bundle) ===')
console.log(JSON.stringify(panelCheck, null, 1))

// 2. Real turn-chrome script
const tc = await page.evaluate((script) => {
  const errors = []
  try {
    ;(0, eval)(script)
  } catch (e) {
    errors.push(String(e))
  }
  const flow = document.querySelector('[data-chat-flow]')
  const bars = flow ? [...flow.querySelectorAll(':scope > .dsh-turn-bar')] : []
  return {
    errors,
    barCount: bars.length,
    bars: bars.slice(0, 6).map((b) => ({
      text: b.textContent.trim().replace(/\s+/g, ' ').slice(0, 46),
      beforeKind: b.nextElementSibling ? b.nextElementSibling.getAttribute('data-chat-flow-kind') : null,
    })),
    hiddenThink: flow ? [...flow.querySelectorAll('[data-variant="think"]')].filter((el) => getComputedStyle(el).display === 'none').length + '/' + flow.querySelectorAll('[data-variant="think"]').length : '-',
    hiddenTools: flow ? [...flow.querySelectorAll(':scope > [data-chat-flow-kind="tool-call"]')].filter((el) => getComputedStyle(el).display === 'none').length + '/' + flow.querySelectorAll(':scope > [data-chat-flow-kind="tool-call"]').length : '-',
    hiddenAssistants: flow ? [...flow.querySelectorAll(':scope > [data-chat-flow-kind="assistant-step"]')].filter((el) => getComputedStyle(el).display === 'none').length + '/' + flow.querySelectorAll(':scope > [data-chat-flow-kind="assistant-step"]').length : '-',
  }
}, TURN_CHROME_SCRIPT)
console.log('=== 2. turn-chrome (real script) ===')
console.log(JSON.stringify(tc, null, 1))

// 3. Click first bar -> that round expands
await page.evaluate(() => {
  const flow = document.querySelector('[data-chat-flow]')
  const bar = flow ? flow.querySelector(':scope > .dsh-turn-bar') : null
  if (bar) bar.click()
})
await page.waitForTimeout(700)
const expandedCheck = await page.evaluate(() => {
  const flow = document.querySelector('[data-chat-flow]')
  const bar = flow ? flow.querySelector(':scope > .dsh-turn-bar') : null
  return {
    firstBarText: bar ? bar.textContent.trim().replace(/\s+/g, ' ').slice(0, 46) : null,
    hiddenThink: flow ? [...flow.querySelectorAll('[data-variant="think"]')].filter((el) => getComputedStyle(el).display === 'none').length : -1,
    hiddenTools: flow ? [...flow.querySelectorAll(':scope > [data-chat-flow-kind="tool-call"]')].filter((el) => getComputedStyle(el).display === 'none').length : -1,
    hiddenAssistants: flow ? [...flow.querySelectorAll(':scope > [data-chat-flow-kind="assistant-step"]')].filter((el) => getComputedStyle(el).display === 'none').length : -1,
    barCount: flow ? flow.querySelectorAll(':scope > .dsh-turn-bar').length : -1,
  }
})
console.log('=== 3. after first bar click ===')
console.log(JSON.stringify(expandedCheck, null, 1))

// 4. Bar survival across a re-render (React clobber check): wait 2s more
await page.waitForTimeout(2500)
const survival = await page.evaluate(() => {
  const flow = document.querySelector('[data-chat-flow]')
  const bars = flow ? flow.querySelectorAll(':scope > .dsh-turn-bar') : []
  return { barCount: bars.length, firstText: bars[0] ? bars[0].textContent.trim().replace(/\s+/g, ' ').slice(0, 46) : null }
})
console.log('=== 4. bar survival after 2.5s ===')
console.log(JSON.stringify(survival, null, 1))

// 5. Toggle cluster above injected chrome (z-index fix)
const chromeCheck = await page.evaluate(() => {
  const bar = document.createElement('div')
  bar.id = 'dsh-window-chrome-test'
  bar.style.cssText = 'position:fixed;inset:0 0 auto 0;height:42px;z-index:2147483600;background:#171d2a;'
  document.body.appendChild(bar)
  const style = document.createElement('style')
  style.textContent = '[class*="toggleCluster"] { top: 7px !important; right: 214px !important; z-index: 2147483647 !important; }'
  document.head.appendChild(style)
  const cluster = document.querySelector('[class*="toggleCluster"]')
  const r = cluster.getBoundingClientRect()
  const topEl = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  return {
    clusterZ: getComputedStyle(cluster).zIndex,
    clusterRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    topElementIsClusterBtn: topEl ? !!topEl.closest('[class*="toggleCluster"]') : false,
  }
})
console.log('=== 5. toggle cluster vs chrome ===')
console.log(JSON.stringify(chromeCheck, null, 1))

await browser.close()
