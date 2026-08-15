/**
 * Inject the Codex-style cockpit (right sidebar + bottom terminal).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const injectPath = path.join(import.meta.dirname, 'cockpit-inject.js')

/** Inject the cockpit overlay into the harness page. */
export async function injectCockpit(webContents) {
  if (webContents === undefined || webContents.isDestroyed()) return
  const source = readFileSync(injectPath, 'utf8')
  await webContents.executeJavaScript(source)
}
