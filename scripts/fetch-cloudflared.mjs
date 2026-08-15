import { existsSync, statSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'

// Fetch the official cloudflared Windows binary into electron/vendor so the
// desktop shell can start Cloudflare Quick Tunnels out of the box. Idempotent:
// an existing binary is kept (cache) unless CLOUDFLARED_FORCE=1 forces a
// re-download. The URL can be overridden (mirror) with CLOUDFLARED_URL.
const root = path.resolve(import.meta.dirname, '..')
const destDir = path.join(root, 'electron', 'vendor')
const dest = path.join(destDir, 'cloudflared.exe')

const DEFAULT_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
// A downloaded stub or a truncated transfer must never be mistaken for the
// real binary: refuse anything below this size (the official exe is ~45 MB).
const MIN_BYTES = 10 * 1024 * 1024

if (!process.env.CLOUDFLARED_FORCE && existsSync(dest) && statSync(dest).size >= MIN_BYTES) {
  console.log(`cloudflared: cached at ${dest} (${statSync(dest).size} bytes)`)
  process.exit(0)
}

const url = process.env.CLOUDFLARED_URL ?? DEFAULT_URL
console.log(`cloudflared: downloading ${url}`)
await mkdir(destDir, { recursive: true })
const response = await fetch(url, { redirect: 'follow' })
if (!response.ok || response.body === null) {
  throw new Error(`cloudflared: download failed (HTTP ${response.status})`)
}
await pipeline(response.body, createWriteStream(dest))
const size = statSync(dest).size
if (size < MIN_BYTES) {
  throw new Error(`cloudflared: downloaded file looks truncated (${size} bytes); delete ${dest} and retry, or set CLOUDFLARED_URL to a mirror`)
}
console.log(`cloudflared: wrote ${dest} (${size} bytes)`)
