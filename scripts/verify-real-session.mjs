// Verify turn-chrome against the REAL live conversation.
import { chromium } from 'file:///D:/jzz/tool/dsh-desktop/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs'
import { TURN_CHROME_SCRIPT } from 'file:///D:/jzz/tool/dsh-desktop/electron/turn-chrome.mjs'

const base = process.argv[2] ?? 'http://127.0.0.1:51881'
const sessionId = process.argv[3] ?? 'session-a83147e7-e783-485c-bf21-70ff3e0cc832'
const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:\\Users\\17367\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1237\\chrome-headless-shell-win64\\chrome-headless-shell.exe',
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 300)))
await page.goto(`${base}/?v=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.evaluate((sid) => {
  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: sid }))
}, sessionId)
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(14_000)

const result = await page.evaluate((script) => {
  const errors = []
  try {
    ;(0, eval)(script)
  } catch (e) {
    errors.push(String(e))
  }
  const flow = document.querySelector('[data-chat-flow]')
  if (!flow) return { errors, flow: false }
  const bars = [...flow.querySelectorAll(':scope > .dsh-turn-bar')]
  const tail = flow.lastElementChild
  return {
    errors,
    flow: true,
    runningTail: tail ? (String(tail.className).includes('turnStatus') || /deep diving/i.test(tail.textContent || '')) : false,
    barCount: bars.length,
    bars: bars.slice(0, 8).map((b) => ({
      text: b.textContent.trim().replace(/\s+/g, ' ').slice(0, 44),
      beforeKind: b.nextElementSibling ? b.nextElementSibling.getAttribute('data-chat-flow-kind') : null,
    })),
    hiddenThink: [...flow.querySelectorAll('[data-variant="think"]')].filter((el) => getComputedStyle(el).display === 'none').length + '/' + flow.querySelectorAll('[data-variant="think"]').length,
    hiddenTools: [...flow.querySelectorAll(':scope > [data-chat-flow-kind="tool-call"]')].filter((el) => getComputedStyle(el).display === 'none').length + '/' + flow.querySelectorAll(':scope > [data-chat-flow-kind="tool-call"]').length,
    hiddenAssistants: [...flow.querySelectorAll(':scope > [data-chat-flow-kind="assistant-step"]')].filter((el) => getComputedStyle(el).display === 'none').length + '/' + flow.querySelectorAll(':scope > [data-chat-flow-kind="assistant-step"]').length,
    // is the LAST round (live turn) still fully visible?
    liveRoundVisible: (() => {
      // last user row onward
      const children = [...flow.children]
      let lastUser = -1
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const k = children[i].getAttribute('data-chat-flow-kind')
        if (k === 'user' || k === 'steering') { lastUser = i; break }
      }
      if (lastUser < 0) return null
      const live = children.slice(lastUser)
      return live.every((el) => getComputedStyle(el).display !== 'none')
    })(),
  }
}, TURN_CHROME_SCRIPT)
console.log(JSON.stringify(result, null, 1))
await browser.close()
