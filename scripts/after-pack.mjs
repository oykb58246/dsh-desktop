import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require2 = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')

/** Find rcedit.exe shipped with electron-winstaller under pnpm. */
async function findRcedit() {
  const pnpm = path.join(root, 'node_modules', '.pnpm')
  for (const dir of await readdir(pnpm)) {
    if (!dir.startsWith('electron-winstaller@')) continue
    const candidate = path.join(pnpm, dir, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe')
    try {
      const { statSync } = require2('node:fs')
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

/** afterPack hook: force the DSH logo + version strings into the app exe. */
export default async function afterPack(context) {
  if (context.packager.platform.name !== 'win') return
  const exe = path.join(context.appOutDir, 'DSH Desktop.exe')
  const icon = path.join(root, 'assets', 'icon.ico')
  const rcedit = await findRcedit()
  if (rcedit === null) throw new Error('rcedit.exe not found (electron-winstaller vendor)')
  await new Promise((resolve, reject) => {
    execFile(
      rcedit,
      [exe, '--set-icon', icon, '--set-version-string', 'ProductName', 'DSH Desktop', '--set-version-string', 'FileDescription', 'DSH Desktop', '--set-version-string', 'CompanyName', 'DSH Desktop', '--set-file-version', '0.1.0.0', '--set-product-version', '0.1.0.0'],
      (error) => (error ? reject(error) : resolve()),
    )
  })
  console.log(`  • rcedit: embedded DSH icon into ${path.basename(exe)}`)
}