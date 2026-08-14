import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const svgPath = path.join(root, 'website', 'assets', 'favicon.svg')
const outputPath = path.join(root, 'assets', 'installer-splash.jpg')
const pnpmRoot = path.join(root, 'deepseek-harness', 'node_modules', '.pnpm')

const sharpDir = (await (await import('node:fs/promises')).readdir(pnpmRoot)).find((name) => name.startsWith('sharp@'))
if (sharpDir === undefined) throw new Error('sharp is required to generate the installer splash')
const sharpEntry = path.join(pnpmRoot, sharpDir, 'node_modules', 'sharp', 'dist', 'index.mjs')
const { default: sharp } = await import(pathToFileURL(sharpEntry).href)

const icon = (await readFile(svgPath)).toString('base64')
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500">
  <defs>
    <radialGradient id="bg" cx="50%" cy="40%" r="75%">
      <stop offset="0%" stop-color="#10275a"/>
      <stop offset="100%" stop-color="#08152d"/>
    </radialGradient>
  </defs>
  <rect width="800" height="500" fill="url(#bg)"/>
  <image x="340" y="150" width="120" height="120" href="data:image/svg+xml;base64,${icon}"/>
  <text x="400" y="330" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="34" font-weight="600" fill="#f2f6ff">DSH Desktop</text>
  <text x="400" y="368" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="16" fill="#8db4e8">正在准备安装…</text>
</svg>`

await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(outputPath)
console.log(`Generated ${outputPath}`)