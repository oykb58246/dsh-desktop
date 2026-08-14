// Temporary inspection script: dump key payload structures from a real Codex rollout.
import { readFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'C:\\Users\\17367\\.codex\\sessions\\2026\\07\\01'
const files = await readdir(dir)
const file = files.find((name) => name.startsWith('rollout-'))
if (!file) throw new Error('no rollout found in ' + dir)

const lines = (await readFile(join(dir, file), 'utf8')).split('\n')
const wanted = new Set([
  'user_message', 'agent_message', 'function_call', 'function_call_output',
  'reasoning', 'thread_rolled_back', 'task_complete', 'session_meta',
  'message', 'turn_context', 'event_msg',
])
const seen = new Set()
const summarize = (value, depth = 0) => {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return `[array len=${value.length}]`
  if (depth > 1) return '{...}'
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === 'content' && Array.isArray(v)) {
      out[k] = v.map((item) => {
        if (item && typeof item === 'object' && item.type) {
          const copy = { type: item.type }
          for (const [ik, iv] of Object.entries(item)) {
            if (ik === 'type') continue
            if (typeof iv === 'string') copy[ik] = iv.length > 200 ? iv.slice(0, 200) + '…' : iv
            else if (iv === null || typeof iv !== 'object') copy[ik] = iv
            else copy[ik] = Array.isArray(iv) ? `[array len=${iv.length}]` : '{...}'
          }
          return copy
        }
        return summarize(item, depth + 1)
      })
    } else if (typeof v === 'string' && v.length > 200) {
      out[k] = v.slice(0, 200) + '…'
    } else if (typeof v === 'object') {
      out[k] = summarize(v, depth + 1)
    } else {
      out[k] = v
    }
  }
  return out
}

for (const line of lines) {
  if (line.trim() === '') continue
  let parsed
  try { parsed = JSON.parse(line) } catch { continue }
  const key = parsed.payload?.type ?? parsed.type
  if (!wanted.has(key) || seen.has(key)) continue
  seen.add(key)
  const short = JSON.stringify(summarize(parsed))
  console.log(`=== ${key} (${line.length} chars) ===`)
  console.log(short.length > 1800 ? short.slice(0, 1800) : short)
  console.log('')
}
