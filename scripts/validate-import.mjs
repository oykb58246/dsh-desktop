// Validation: convert a real Codex rollout, write the zstd artifact, and read
// it back with dsh's own JSONL scanner (the persistence backend's reader).
import { convertRollout, importSessionFromRollout, sessionLogPath, projectKey, encodeSegment } from '../electron/codex-import.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const zlib = require('node:zlib')

const rollout = process.argv[2]
const dshHome = await mkdtemp(join(tmpdir(), 'dsh-import-validate-'))
const cwd = 'D:\\harness-projects\\demo-project'

try {
  const { header, events } = await convertRollout(rollout, cwd)
  console.log('=== header ===')
  console.log(JSON.stringify(header, null, 2))
  console.log('=== event sequence ===')
  for (const event of events) {
    const data = JSON.stringify(event.data)
    console.log(`seq=${event.seq} type=${event.type} time=${event.time} data=${data.length > 140 ? data.slice(0, 140) + '…' : data}`)
  }
  console.log(`total events: ${events.length}`)

  // seq contiguity check
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq !== i) throw new Error(`seq gap at index ${i}: ${events[i].seq}`)
  }

  // surface events must carry surfaceOp
  for (const event of events) {
    if (['user/message', 'assistant/message', 'tool/result'].includes(event.type) && event.surfaceOp !== 'append') {
      throw new Error(`surface event ${event.type} seq=${event.seq} missing surfaceOp`)
    }
  }

  // write and read back with a frame scanner matching dsh's zstd reader
  // (header is its own frame; each event batch is another frame).
  const outcome = await importSessionFromRollout({ rollout, cwd, dshHome })
  console.log('=== written ===')
  console.log(outcome.logPath)

  const raw = await readFile(outcome.logPath)
  const frames = scanFrames(raw)
  if (frames.length < 2) throw new Error(`expected >=2 zstd frames, got ${frames.length}`)
  const plaintext = frames.map(([start, end]) => zlib.zstdDecompressSync(raw.subarray(start, end)))
    .map((buf) => buf.toString('utf8'))
    .join('\n')
  console.log('=== frame count ===', frames.length)
  console.log('=== decoded plaintext (first 400 chars) ===')
  console.log(plaintext.slice(0, 400))

  const lines = plaintext.toString('utf8').split('\n').filter((l) => l.trim() !== '')
  const headerLine = JSON.parse(lines[0])
  if (headerLine.type !== 'session' || headerLine.id !== header.id) {
    throw new Error('header line mismatch after round-trip')
  }
  const eventLines = lines.slice(1)
  if (eventLines.length !== events.length) {
    throw new Error(`event count mismatch: ${eventLines.length} vs ${events.length}`)
  }
  for (let i = 0; i < eventLines.length; i++) {
    const parsed = JSON.parse(eventLines[i])
    if (parsed.seq !== i) throw new Error(`round-trip seq mismatch at ${i}`)
  }
  console.log('=== ROUND-TRIP OK: header +', eventLines.length, 'events readable by zstd ===')
  console.log('path keys:', projectKey(cwd), encodeSegment(header.id))
  console.log('expected path:', sessionLogPath(dshHome, cwd, header.id))
} finally {
  await rm(dshHome, { recursive: true, force: true })
}

/** Minimal Zstandard frame scan: locate complete frames (magic + block walk). */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  const ZSTD_MAGIC = 0xFD2FB528
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('bad zstd magic')
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    offset += remainingHeaderBytes
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('reserved zstd block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push([start, offset])
  }
  return frames
}
