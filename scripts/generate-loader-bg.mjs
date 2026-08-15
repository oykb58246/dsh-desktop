import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Render the native loader's background: a 560x720 frame matching the
// Electron installer window's ocean design (dark gradient + whale + brand).
// The status line and progress bar are painted at runtime over this bitmap,
// so they are intentionally NOT baked in.
const root = path.resolve(import.meta.dirname, '..')
const svgPath = path.join(root, 'website', 'assets', 'favicon.svg')
const outputPath = path.join(root, 'loader', 'loader-bg.png')
const pnpmRoot = path.join(root, 'deepseek-harness', 'node_modules', '.pnpm')

const sharpDir = (await (await import('node:fs/promises')).readdir(pnpmRoot)).find((name) => name.startsWith('sharp@'))
if (sharpDir === undefined) throw new Error('sharp is required to generate the loader background')
const sharpEntry = path.join(pnpmRoot, sharpDir, 'node_modules', 'sharp', 'dist', 'index.mjs')
const { default: sharp } = await import(pathToFileURL(sharpEntry).href)

const icon = (await readFile(svgPath)).toString('base64')
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="560" height="720">
  <defs>
    <radialGradient id="bg" cx="50%" cy="40%" r="80%">
      <stop offset="0%" stop-color="#10275a"/>
      <stop offset="100%" stop-color="#08152d"/>
    </radialGradient>
  </defs>
  <rect width="560" height="720" fill="url(#bg)"/>
  <circle cx="280" cy="330" r="120" fill="rgba(77,107,254,0.22)" />
  <image x="216" y="230" width="128" height="128" href="data:image/svg+xml;base64,${icon}"/>
  <text x="280" y="430" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="26" font-weight="600" fill="#f2f6ff">DSH Desktop</text>
</svg>`

await sharp(Buffer.from(svg)).png().toFile(outputPath)
console.log(`Generated ${outputPath}`)

// The Go-native installer's background: landscape 760x480, the whale sits in
// the self-drawn title bar (top-left), the page content owns the middle.
const installerSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="760" height="480">
  <defs>
    <radialGradient id="bg2" cx="50%" cy="45%" r="85%">
      <stop offset="0%" stop-color="#10275a"/>
      <stop offset="100%" stop-color="#08152d"/>
    </radialGradient>
  </defs>
  <rect width="760" height="480" fill="url(#bg2)"/>
  <circle cx="380" cy="250" r="160" fill="rgba(77,107,254,0.14)" />
  <image x="14" y="8" width="24" height="24" href="data:image/svg+xml;base64,${icon}"/>
</svg>`

await sharp(Buffer.from(installerSvg)).png().toFile(path.join(root, 'loader', 'installer-bg.png'))
console.log(`Generated ${path.join(root, 'loader', 'installer-bg.png')}`)
