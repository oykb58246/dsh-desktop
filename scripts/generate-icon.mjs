import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const svgPath = path.join(root, 'website', 'assets', 'favicon.svg')
const outputPath = path.join(root, 'assets', 'icon.ico')
const pnpmRoot = path.join(root, 'deepseek-harness', 'node_modules', '.pnpm')
const sharpDir = (await readdir(pnpmRoot)).find((name) => name.startsWith('sharp@'))
if (sharpDir === undefined) throw new Error('sharp is required to generate the Windows icon')
const sharpEntry = path.join(pnpmRoot, sharpDir, 'node_modules', 'sharp', 'dist', 'index.mjs')
const { default: sharp } = await import(pathToFileURL(sharpEntry).href)

const svg = await readFile(svgPath)
const sizes = [16, 24, 32, 48, 64, 128, 256]

// Build a classic (BMP/DIB-entry) ICO.  Legacy rcedit ignores PNG-compressed
// entries, which silently drops the icon; DIB entries are universally accepted.
const entries = []
const images = []
let offset = 6 + 16 * sizes.length
for (const size of sizes) {
  const png = await sharp(svg).resize(size, size).png().toBuffer()
  const { width, height } = await sharp(png).metadata()
  // sharp's raw output is RGBA; a 32bpp DIB stores BGRA. Swap R/B per pixel
  // before the vertical flip, otherwise the blue and red channels exchange
  // (the blue whale would render red).
  const rgba = await sharp(png).ensureAlpha().raw().toBuffer()
  const bgra = Buffer.from(rgba)
  for (let i = 0; i < bgra.length; i += 4) {
    const r = bgra[i]
    bgra[i] = bgra[i + 2]
    bgra[i + 2] = r
  }
  // flip to bottom-up for DIB
  const stride = width * 4
  const flipped = Buffer.alloc(bgra.length)
  for (let y = 0; y < height; y += 1) {
    bgra.copy(flipped, (height - 1 - y) * stride, y * stride, (y + 1) * stride)
  }
  // AND mask: one bit per pixel, rows padded to 32 bits
  const maskStride = Math.ceil(width / 32) * 4
  const mask = Buffer.alloc(maskStride * height)
  const dibSize = 40 + width * height * 4 + mask.length
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size === 256 ? 0 : size, 0)
  entry.writeUInt8(size === 256 ? 0 : size, 1)
  entry.writeUInt8(0, 2)
  entry.writeUInt8(0, 3)
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(dibSize, 8)
  entry.writeUInt32LE(offset, 12)
  entries.push(entry)
  const dib = Buffer.alloc(dibSize)
  dib.writeUInt32LE(40, 0)
  dib.writeInt32LE(width, 4)
  dib.writeInt32LE(height * 2, 8)
  dib.writeUInt16LE(1, 12)
  dib.writeUInt16LE(32, 14)
  dib.writeUInt32LE(0, 16)
  dib.writeUInt32LE(width * height * 4, 20)
  dib.writeInt32LE(0, 24)
  dib.writeInt32LE(0, 28)
  dib.writeUInt32LE(0, 32)
  dib.writeUInt32LE(0, 36)
  flipped.copy(dib, 40)
  mask.copy(dib, 40 + width * height * 4)
  images.push(dib)
  offset += dibSize
}
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
await writeFile(outputPath, Buffer.concat([header, ...entries, ...images]))
console.log(`Generated ${outputPath} (${sizes.join(',')}px, DIB entries)`)