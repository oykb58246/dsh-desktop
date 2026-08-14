import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const electronRoot = path.join(root, 'node_modules', 'electron')
const binaryName = process.platform === 'win32' ? 'electron.exe' : 'electron'
const binaryPath = path.join(electronRoot, 'dist', binaryName)

if (existsSync(binaryPath)) {
  process.exit(0)
}

const child = spawn(process.execPath, [path.join(electronRoot, 'install.js')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_MIRROR:
      process.env.ELECTRON_MIRROR ??
      'https://npmmirror.com/mirrors/electron/',
  },
})

child.once('error', (error) => {
  console.error(error)
  process.exit(1)
})

child.once('exit', (code) => {
  process.exit(code ?? 1)
})
