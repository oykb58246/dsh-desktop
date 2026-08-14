const { execFile } = require('node:child_process')
const { readdirSync, statSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

function findRcedit() {
  const pnpm = path.join(root, 'node_modules', '.pnpm')
  for (const dir of readdirSync(pnpm)) {
    if (!dir.startsWith('electron-winstaller@')) continue
    const candidate = path.join(pnpm, dir, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe')
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

module.exports = async function afterPack(context) {
  if (context.packager.platform.name !== 'win') return
  const exe = path.join(context.appOutDir, 'DSH Desktop.exe')
  const icon = path.join(root, 'assets', 'icon.ico')
  const rcedit = findRcedit()
  if (rcedit === null) throw new Error('rcedit.exe not found (electron-winstaller vendor)')
  await new Promise((resolve, reject) => {
    execFile(
      rcedit,
      [exe, '--set-icon', icon, '--set-version-string', 'ProductName', 'DSH Desktop', '--set-version-string', 'FileDescription', 'DSH Desktop', '--set-version-string', 'CompanyName', 'DSH Desktop'],
      (error) => (error ? reject(error) : resolve()),
    )
  })
  console.log(`  • rcedit: embedded DSH icon into ${path.basename(exe)}`)
}