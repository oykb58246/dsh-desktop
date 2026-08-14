const { execFileSync } = require('node:child_process')
const { readdirSync, statSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const icon = path.join(root, 'assets', 'icon.ico')

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
  throw new Error('rcedit.exe not found (electron-winstaller vendor)')
}

const rcedit = findRcedit()
const targets = [
  // The portable stub gets its icon from the NSIS compiler; the legacy rcedit
]

for (const exe of targets) {
  try {
    execFileSync(rcedit, [
      exe, '--set-icon', icon,
      '--set-version-string', 'ProductName', 'DSH Desktop',
      '--set-version-string', 'FileDescription', 'DSH Desktop',
      '--set-version-string', 'CompanyName', 'DSH Desktop',
      '--set-version-string', 'LegalCopyright', 'DeepSeek Harness',
      '--set-file-version', '0.1.0.0',
      '--set-product-version', '0.1.0.0',
    ], { stdio: 'ignore' })
    console.log(`  • icon embedded into ${path.basename(exe)}`)
  } catch (error) {
    console.error(`  • icon embedding failed for ${exe}: ${error.message}`)
    process.exitCode = 1
  }
}