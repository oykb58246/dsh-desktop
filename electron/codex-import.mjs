/**
 * Codex project import executor: target-directory preflight, project copy, and
 * rollout → dsh session-log conversion. All write paths are explicit user
 * actions; every function here is called through main-process IPC.
 *
 * Session-log writing mirrors the deepseek-harness JSONL persistence backend:
 * `$DSH_HOME/sessions/<projectKey(cwd)>/<encodedSessionId>/session.jsonl.zstd`
 * with the header as its own checksummed Zstandard frame followed by one frame
 * of event lines (see packages/session/session-persistence-jsonl). The two
 * path-encoding helpers (projectKey / encodeSegment) are reimplemented from
 * that package's format.ts so the desktop shell needs no dependency on dsh
 * packages.
 *
 * @module codex-import
 */

import { randomUUID } from 'node:crypto'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, stat, copyFile, open, rename } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const zstdCompressAsync = promisify(zstdCompress)
const zstdDecompressAsync = promisify(zstdDecompress)

/** Checksummed Zstandard frames, matching the dsh backend's write options. */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** Directories never copied into the Harness target (mirrors the scanner). */
const COPY_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  '.output',
  'node_modules',
  'dist',
  'build',
  'build-output',
  'fast-output',
  'out',
  'output',
  'target',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
])

/**
 * The auto-detected Codex sessions root: `~/.codex/sessions`, honouring the
 * `CODEX_HOME` environment variable when set (mirrors cockpit-tools' default
 * codex-home resolution).
 * @returns the absolute default sessions directory.
 */
export function defaultCodexSessionsRoot() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  return path.join(home, 'sessions')
}

/**
 * The effective Codex sessions root: the user-chosen custom root when given,
 * otherwise the auto-detected default.
 * @param customRoot - user-configured sessions root, or null/empty for default.
 * @returns the absolute sessions directory.
 */
export function codexSessionsRoot(customRoot) {
  return customRoot !== undefined && customRoot !== null && String(customRoot).trim() !== ''
    ? path.resolve(String(customRoot).trim())
    : defaultCodexSessionsRoot()
}

/**
 * The Codex session index file path for a sessions root. The index lives next
 * to the sessions directory (inside the Codex home).
 * @param customRoot - user-configured sessions root, or null/empty for default.
 * @returns the absolute session_index.jsonl path.
 */
export function codexSessionIndexPath(customRoot) {
  return path.join(path.dirname(codexSessionsRoot(customRoot)), 'session_index.jsonl')
}

/**
 * Encode an arbitrary string as one safe path segment, injectively over all
 * JS strings. Safe code units stay literal; every other unit becomes `~XXXX`.
 * Mirrors @deepseek-ai/dsh-session-persistence-jsonl's format.encodeSegment.
 * @param raw - the string to encode; must be non-empty.
 * @returns the escaped single path segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/**
 * Inverse of {@link encodeSegment}: turn an encoded path segment back into
 * the original string. Returns null when the segment is not a valid encoding
 * (missing escape digits, bare tilde).
 * @param segment - the encoded single path segment.
 * @returns the decoded string, or null.
 */
export function decodeSegment(segment) {
  if (segment === '~002E') return '.'
  if (segment === '~002E~002E') return '..'
  let out = ''
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (ch === '~') {
      if (i + 4 >= segment.length) return null
      const hex = segment.slice(i + 1, i + 5)
      if (!/^[0-9A-F]{4}$/.test(hex)) return null
      out += String.fromCharCode(parseInt(hex, 16))
      i += 4
    } else {
      out += ch
    }
  }
  return out
}

/**
 * Build the readable directory key for a project path: separators become `-`,
 * unsafe units use the `~XXXX` escape. Mirrors format.projectKey.
 * @param cwd - the session's project directory.
 * @returns a single filesystem-safe project directory name.
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * The dsh session log path for one session.
 * @param dshHome - the resolved DSH_HOME directory.
 * @param cwd - the session's project directory.
 * @param id - the session id.
 * @returns the absolute `.jsonl.zstd` artifact path.
 */
export function sessionLogPath(dshHome, cwd, id) {
  return path.join(
    dshHome,
    'sessions',
    projectKey(cwd),
    encodeSegment(id),
    'session.jsonl.zstd',
  )
}

/**
 * Read one imported session log's header (the first zstd frame) and return
 * its stored cwd. Used to repair workspace grouping for previously imported
 * sessions.
 * @param artifactPath - the `.jsonl.zstd` session artifact path.
 * @returns the header cwd, or null when unreadable.
 */
export async function readSessionLogCwd(artifactPath) {
  try {
    const raw = await readFile(artifactPath)
    // First frame only: locate its end (magic + descriptor + blocks + checksum).
    const end = firstZstdFrameEnd(raw)
    if (end === -1) return null
    const plain = await zstdDecompressAsync(raw.subarray(0, end))
    const firstLine = plain.toString('utf8').split('\n', 1)[0]
    const header = JSON.parse(firstLine)
    return typeof header?.cwd === 'string' ? header.cwd : null
  } catch {
    return null
  }
}

/** Locate the end offset of the first Zstandard frame in a buffer, or -1. */
function firstZstdFrameEnd(buffer) {
  const ZSTD_MAGIC = 0xFD2FB528
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) return -1
  let offset = 4
  if (offset >= buffer.length) return -1
  const descriptor = buffer.readUInt8(offset)
  offset += 1
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (buffer.length - offset < remainingHeaderBytes) return -1
  offset += remainingHeaderBytes
  for (;;) {
    if (buffer.length - offset < 3) return -1
    const blockHeader = buffer.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    const blockSize = blockHeader >>> 3
    if (blockType === 0x03) return -1
    const payloadBytes = blockType === 0x01 ? 1 : blockSize
    if (buffer.length - offset < payloadBytes) return -1
    offset += payloadBytes
    if (lastBlock) break
  }
  if (checksum) {
    if (buffer.length - offset < 4) return -1
    offset += 4
  }
  return offset
}

/**
 * Preflight a project list against a target root: reports directories that
 * already exist in the target (name conflicts) and sessions already imported
 * into dsh (id conflicts). Never mutates anything.
 * @param targetRoot - the user-chosen Harness project root directory.
 * @param projects - scanned projects (name / absolutePath).
 * @param dshHome - the resolved DSH_HOME directory (may be absent).
 * @param customSessionsRoot - user-configured Codex sessions root, or
 *   null/empty for the auto-detected default.
 * @returns per-project conflict report.
 */
export async function precheckImport(targetRoot, projects, dshHome, customSessionsRoot) {
  const reports = []
  for (const project of projects) {
    const targetPath = path.join(targetRoot, project.name)
    let targetExists = false
    try {
      targetExists = (await stat(targetPath)).isDirectory()
    } catch {
      targetExists = false
    }
    reports.push({
      name: project.name,
      targetPath,
      targetExists,
      sessions: await findProjectRollouts(project.absolutePath, customSessionsRoot),
    })
  }
  return {
    targetRoot,
    dshHome,
    reports,
  }
}

/**
 * Recursively copy one project directory into the target root, skipping
 * dependency/build directories. Reports progress per file.
 * @param targetRoot - the Harness project root directory (must exist).
 * @param projects - scanned projects to copy.
 * @param onProgress - callback `({ phase, name, file, done, total })`.
 * @returns per-project copy summary with the target paths.
 */
export async function copyProjects(targetRoot, projects, onProgress) {
  const results = []
  for (const project of projects) {
    const targetPath = path.join(targetRoot, project.name)
    const fileList = []
    await collectFiles(project.absolutePath, fileList)
    const total = fileList.length
    let done = 0
    onProgress?.({ phase: 'copy', name: project.name, file: '', done, total })
    await mkdir(targetPath, { recursive: true })
    for (const relative of fileList) {
      const source = path.join(project.absolutePath, relative)
      const destination = path.join(targetPath, relative)
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(source, destination)
      done += 1
      onProgress?.({ phase: 'copy', name: project.name, file: relative, done, total })
    }
    results.push({ name: project.name, targetPath, files: done })
  }
  return results
}

/**
 * Collect every copyable file path under a directory (relative paths).
 * @param root - directory to walk.
 * @param out - the accumulator array.
 * @param prefix - accumulated relative directory prefix (internal recursion).
 */
async function collectFiles(root, out, prefix = '') {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (COPY_IGNORED_DIRECTORIES.has(entry.name)) continue
      await collectFiles(entryPath, out, path.join(prefix, entry.name))
      continue
    }
    if (!entry.isFile()) continue
    out.push(path.join(prefix, entry.name))
  }
}

/**
 * Scan the Codex sessions root and aggregate every rollout into per-cwd
 * project groups — the cockpit-style "everything at a glance" listing the
 * tools window renders on open (no prior directory pick needed).
 * @param customRoot - user-configured sessions root, or null/empty for the
 *   auto-detected default (`~/.codex/sessions` or `$CODEX_HOME/sessions`).
 * @returns `{ sessionsRoot, projects }` where each project carries its cwd,
 *   display name, and the rollouts whose session_meta.cwd equals it.
 */
export async function scanAllCodexSessions(customRoot) {
  const root = codexSessionsRoot(customRoot)
  const index = await readSessionIndex(customRoot)
  const sessions = []
  const scanDir = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await scanDir(entryPath)
        continue
      }
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue
      try {
        const meta = await readRolloutMeta(entryPath)
        if (meta === null) continue
        sessions.push({
          id: meta.id ?? entry.name,
          title: index.get(meta.id ?? '') ?? '',
          cwd: meta.cwd ?? '',
          file: entryPath,
          startedAt: meta.startedAt,
          model: meta.model,
        })
      } catch {
        // Unreadable rollouts are skipped; the import step reports them.
      }
    }
  }
  await scanDir(root)

  const byCwd = new Map()
  for (const session of sessions) {
    const cwd = session.cwd
    if (!byCwd.has(cwd)) {
      byCwd.set(cwd, {
        name: cwd === '' ? '(未记录目录)' : path.basename(cwd) || cwd,
        cwd,
        shallow: isShallowDirectory(cwd),
        sessions: [],
      })
    }
    byCwd.get(cwd).sessions.push(session)
  }
  const projects = [...byCwd.values()].map((project) => {
    project.sessions.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    return project
  })
  projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return { sessionsRoot: root, projects }
}

/**
 * Whether a working directory is too shallow (or too broad) to copy as a
 * project — drive roots, the user profile, and aggregate folders like
 * `C:\Users\me` or `D:\jzz`. Such groups still import their sessions, but the
 * whole directory is never copied into the Harness target.
 * @param cwd - the session working directory.
 * @returns true when the directory should be session-only.
 */
function isShallowDirectory(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return true
  const parts = path.resolve(cwd).split(path.sep).filter((part) => part !== '')
  // Windows drive roots yield one part (`C:`), POSIX roots zero; a project
  // under the user profile needs at least three meaningful segments.
  return parts.length <= 3
}

/**
 * Find every Codex rollout whose session cwd sits inside (or equals) one
 * project directory. Scans the Codex sessions tree once for all projects.
 * @param projectPath - the source project directory.
 * @param customRoot - user-configured sessions root, or null/empty for the
 *   auto-detected default (`~/.codex/sessions` or `$CODEX_HOME/sessions`).
 * @returns rollout summaries `{ id, title, cwd, file, startedAt, model }`.
 */
export async function findProjectRollouts(projectPath, customRoot) {
  const root = codexSessionsRoot(customRoot)
  const index = await readSessionIndex(customRoot)
  const found = []
  const scanDir = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await scanDir(entryPath)
        continue
      }
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue
      try {
        const meta = await readRolloutMeta(entryPath)
        if (meta === null) continue
        // A session belongs to a project when its cwd is inside the project
        // directory, OR when the project sits inside the session's cwd
        // (Codex workspace roots often nest the project under work/). A
        // session rooted at a very shallow ancestor (e.g. the user profile)
        // is not attributed to every project below it.
        if (!sessionRelatesToProject(meta.cwd, projectPath)) continue
        const id = meta.id ?? entry.name
        found.push({
          id,
          title: index.get(id) ?? '',
          cwd: meta.cwd,
          file: entryPath,
          startedAt: meta.startedAt,
          model: meta.model,
        })
      } catch {
        // Unreadable rollouts are skipped; the import step reports them.
      }
    }
  }
  await scanDir(root)
  found.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
  return found
}

/**
 * Read the Codex session index into a Map of id → thread_name. The index sits
 * next to the sessions directory; a custom root without an index yields an
 * empty map (titles then fall back to the rollout id).
 * @param customRoot - user-configured sessions root, or null/empty for default.
 * @returns the id-to-title map.
 */
async function readSessionIndex(customRoot) {
  const map = new Map()
  let content
  try {
    content = await readFile(codexSessionIndexPath(customRoot), 'utf8')
  } catch {
    return map
  }
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue
    try {
      const entry = JSON.parse(line)
      if (typeof entry.id === 'string' && typeof entry.thread_name === 'string') {
        map.set(entry.id, entry.thread_name)
      }
    } catch {
      // Skip malformed index lines.
    }
  }
  return map
}

/**
 * Read just the session_meta record of a rollout file.
 * @param file - the rollout path.
 * @returns `{ id, cwd, startedAt, model }` or null when unreadable/absent.
 */
async function readRolloutMeta(file) {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(1 << 16)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = head.indexOf('\n')
    const first = newline === -1 ? head : head.slice(0, newline)
    const parsed = JSON.parse(first)
    if (parsed?.type !== 'session_meta') return null
    const payload = parsed.payload ?? {}
    return {
      id: payload.session_id ?? payload.id ?? null,
      cwd: payload.cwd ?? null,
      startedAt: payload.timestamp ?? parsed.timestamp ?? null,
      model: payload.model_provider ?? null,
    }
  } finally {
    await handle.close()
  }
}

/** Whether `child` equals `parent` or lies under it (case-insensitive on win32). */
function isInside(child, parent) {
  const relative = path.relative(parent, child)
  if (relative === '') return true
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  return true
}

/**
 * Whether a session cwd relates to a project directory: the cwd lies inside
 * the project, or the project lies inside the cwd with at most two extra
 * nesting levels (Codex workspace roots commonly hold the project under
 * `work/` or `work/<name>/`). Shallow ancestors like the user profile root
 * are not attributed to every project beneath them.
 * @param cwd - the session's working directory.
 * @param projectPath - the project directory.
 * @returns true when the session plausibly belongs to the project.
 */
function sessionRelatesToProject(cwd, projectPath) {
  if (isInside(cwd, projectPath)) return true
  if (!isInside(projectPath, cwd)) return false
  const depth = depthDelta(projectPath, cwd)
  return depth >= 0 && depth <= 2
}

/** How many extra path segments `deep` adds below `shallow` (both absolute). */
function depthDelta(deep, shallow) {
  const deepParts = path.resolve(deep).split(path.sep)
  const shallowParts = path.resolve(shallow).split(path.sep)
  if (shallowParts.length >= deepParts.length) return -1
  for (let i = 0; i < shallowParts.length; i++) {
    if (deepParts[i].toLowerCase() !== shallowParts[i].toLowerCase()) return -1
  }
  return deepParts.length - shallowParts.length
}

/**
 * Convert one Codex rollout into a dsh session log (header + events), then
 * write it as a zstd-compressed artifact under DSH_HOME/sessions.
 * @param options - `{ rollout, cwd, sessionId, dshHome, onEvent }`.
 * @returns `{ sessionId, cwd, logPath, events, skipped }`.
 */
export async function importSessionFromRollout({ rollout, cwd, sessionId, dshHome, onEvent }) {
  const { header, events } = await convertRollout(rollout, cwd, sessionId)
  const logPathResult = sessionLogPath(dshHome, cwd, header.id)
  await mkdir(path.dirname(logPathResult), { recursive: true })
  const headerFrame = await zstdCompressAsync(Buffer.from(`${JSON.stringify(toHeaderLine(header))}\n`), CHECKSUM_OPTIONS)
  const body = events.map((event) => JSON.stringify(event)).join('\n')
  const eventFrame = await zstdCompressAsync(Buffer.from(`${body}\n`), CHECKSUM_OPTIONS)
  const artifact = Buffer.concat([headerFrame, eventFrame])
  await writeFileAtomic(logPathResult, artifact)
  onEvent?.({ kind: 'written', sessionId: header.id, cwd, logPath: logPathResult, events: events.length })
  return { sessionId: header.id, cwd, logPath: logPathResult, events: events.length }
}

/** The storage header line shape (matches format.toHeaderLine). */
function toHeaderLine(header) {
  return {
    type: 'session',
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    delegationDepth: header.delegationDepth ?? 0,
  }
}

/** Write bytes to a temp file in the same directory, then rename over the target. */
async function writeFileAtomic(target, data) {
  const temp = path.join(path.dirname(target), `.dsh-import-${randomUUID()}.tmp`)
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(temp)
    stream.once('error', reject)
    stream.once('finish', resolve)
    stream.end(data)
  })
  await rename(temp, target)
}

/**
 * Parse a rollout file into a dsh session header and event list.
 *
 * Mapping (Codex → dsh):
 * - `event_msg/user_message` → `user/message` (the authoritative user input;
 *   role=user `response_item` messages duplicate it and are skipped)
 * - `event_msg/agent_message` and `response_item/message` (assistant) →
 *   `assistant/message` text blocks
 * - `response_item/function_call` → tool-call block appended to the nearest
 *   assistant message (or a standalone assistant message)
 * - `response_item/function_call_output` → `tool/result`
 * - `turn_context.model` → `request/header` config
 * - `event_msg/task_complete` / `turn_aborted` → `turn/end` reason
 * - `response_item/reasoning` (encrypted) and role=developer messages are
 *   skipped: their content is not readable or not conversation.
 *
 * @param file - the rollout path.
 * @param cwd - the session's working directory (target project path).
 * @param sessionId - explicit session id; defaults to the rollout's own.
 * @returns `{ header, events }` with contiguous seqs from 0.
 */
export async function convertRollout(file, cwd, sessionId) {
  const content = await readFile(file, 'utf8')
  const records = []
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A malformed line ends the conversion of this session.
      break
    }
  }

  let meta = null
  const turns = []
  let currentTurn = null
  for (const record of records) {
    const payload = record.payload ?? {}
    if (record.type === 'session_meta') {
      meta = payload
      continue
    }
    if (payload.type === 'user_message') {
      currentTurn = { user: payload, userTime: record.timestamp, items: [] }
      turns.push(currentTurn)
      continue
    }
    if (currentTurn !== null) currentTurn.items.push(record)
  }

  const id = sessionId ?? meta?.session_id ?? meta?.id ?? fileIdFallback(file)
  const firstUserTime = turns[0]?.userTime
  const createdAt = parseTimestamp(meta?.timestamp)
    ?? (firstUserTime !== undefined ? parseTimestamp(firstUserTime) : undefined)
    ?? Date.now()
  const header = {
    version: 0,
    id,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    cwd,
    delegationDepth: 0,
  }

  const events = []
  let seq = 0
  const push = (type, time, data, surfaceOp) => {
    const event = { type, seq, time, data }
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
    events.push(event)
    seq += 1
  }

  const model = meta?.model_provider ? { provider: 'codex', model: meta.model_provider } : { provider: 'codex', model: 'unknown' }
  let turnNumber = 0
  for (const turn of turns) {
    turnNumber += 1
    const userTime = parseTimestamp(turn.userTime) ?? Date.now()
    push('turn/start', userTime, { turn: turnNumber })
    const userBlocks = userMessageBlocks(turn.user)
    if (userBlocks.length === 0) userBlocks.push({ type: 'text', text: '' })
    push('user/message', userTime, {
      id: messageId(turn.user?.client_id ?? `user-${id}-${turnNumber}`),
      role: 'user',
      content: userBlocks,
      source: { kind: 'user' },
    }, 'append')

    push('step/start', userTime, { turn: turnNumber, step: 1 })
    push('request/header', userTime, {
      header: { config: model },
      reason: turnNumber === 1 ? 'initial' : 'resume',
    })

    let pendingAssistant = null
    let lastTime = userTime
    for (const record of turn.items) {
      const payload = record.payload ?? {}
      const time = parseTimestamp(record.timestamp) ?? userTime
      lastTime = time
      if (record.type === 'response_item' && payload.type === 'message') {
        if (payload.role === 'assistant') {
          const text = assistantText(payload)
          if (text.length === 0) continue
          const msg = {
            id: messageId(payload.id ?? `assistant-${id}-${turnNumber}-${events.length}`),
            role: 'assistant',
            content: [{ type: 'text', text }],
            source: { kind: 'model', provider: model.provider, model: model.model },
          }
          push('assistant/message', time, { turn: turnNumber, step: 1, message: msg }, 'append')
          pendingAssistant = events[events.length - 1]
        }
        // role=user and role=developer response_item messages are skipped.
        continue
      }
      if (record.type === 'response_item' && payload.type === 'function_call') {
        const callId = payload.call_id ?? payload.id ?? randomUUID()
        const toolCall = {
          type: 'tool-call',
          id: callId,
          name: payload.name ?? 'unknown',
          arguments: typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.arguments ?? {}),
        }
        if (pendingAssistant !== null) {
          pendingAssistant.data.message.content.push(toolCall)
        } else {
          const msg = {
            id: messageId(`assistant-tool-${callId}`),
            role: 'assistant',
            content: [toolCall],
            source: { kind: 'model', provider: model.provider, model: model.model },
          }
          push('assistant/message', time, { turn: turnNumber, step: 1, message: msg }, 'append')
          pendingAssistant = events[events.length - 1]
        }
        continue
      }
      if (record.type === 'response_item' && payload.type === 'function_call_output') {
        const callId = payload.call_id ?? randomUUID()
        const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? {})
        const msg = {
          id: messageId(`tool-result-${callId}`),
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text: output }],
          }],
          source: { kind: 'tool', callId },
        }
        push('tool/result', time, { turn: turnNumber, step: 1, message: msg }, 'append')
        pendingAssistant = null
        continue
      }
      if (record.type === 'event_msg' && payload.type === 'agent_message' && typeof payload.message === 'string') {
        const text = payload.message.trim()
        if (text.length === 0) continue
        const msg = {
          id: messageId(`agent-${turnNumber}-${events.length}`),
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: model.provider, model: model.model },
        }
        push('assistant/message', time, { turn: turnNumber, step: 1, message: msg }, 'append')
        pendingAssistant = events[events.length - 1]
        continue
      }
      // reasoning (encrypted), task_started/task_complete markers, and
      // thread_rolled_back are logged for reference only.
    }

    push('step/end', lastTime, { turn: turnNumber, step: 1 })
    const endReason = turnEndReason(turn.items)
    push('turn/end', lastTime, { turn: turnNumber, reason: endReason })
  }

  return { header, events }
}

/** Fallback session id from the rollout filename. */
function fileIdFallback(file) {
  const base = path.basename(file, '.jsonl').replace(/^rollout-/, '')
  return base || randomUUID()
}

/**
 * Build user-message content blocks from an `event_msg/user_message` payload.
 * Local images degrade to text placeholders (bytes live outside the session
 * log; importing them would require the attachment service).
 * @param payload - the user_message payload.
 * @returns the content block list.
 */
function userMessageBlocks(payload) {
  const blocks = []
  const text = (payload?.message ?? '').trim()
  if (text.length > 0) blocks.push({ type: 'text', text })
  const images = payload?.local_images ?? payload?.images ?? []
  for (const image of images) {
    const ref = typeof image === 'string' ? image : image?.path ?? image?.file ?? JSON.stringify(image)
    blocks.push({ type: 'text', text: `[图片: ${ref}]` })
  }
  return blocks
}

/**
 * Extract the visible text of an assistant `response_item/message` payload.
 * @param payload - the message payload.
 * @returns concatenated output text.
 */
function assistantText(payload) {
  const parts = []
  for (const block of payload.content ?? []) {
    if (block?.type === 'output_text' && typeof block.text === 'string') {
      const text = block.text.trim()
      if (text.length > 0) parts.push(text)
    } else if (block?.type === 'input_text' && typeof block.text === 'string') {
      const text = block.text.trim()
      if (text.length > 0) parts.push(text)
    }
  }
  return parts.join('\n\n')
}

/**
 * Derive the turn/end reason from the turn's marker events.
 * @param items - the turn's raw records.
 * @returns a TurnEndReason-compatible value.
 */
function turnEndReason(items) {
  for (const record of items) {
    const type = record?.payload?.type
    if (type === 'turn_aborted') return { kind: 'aborted', reason: { kind: 'legacy' } }
  }
  return { kind: 'completed' }
}

/**
 * Parse an ISO timestamp to epoch milliseconds.
 * @param value - timestamp string or number.
 * @returns epoch ms, or undefined when unparseable.
 */
function parseTimestamp(value) {
  if (typeof value === 'number') return value * (value < 1e12 ? 1000 : 1)
  if (typeof value !== 'string' || value === '') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** Stable message identity: reuse the source id when present, else a UUID. */
function messageId(source) {
  return typeof source === 'string' && source.length > 0 ? source : randomUUID()
}
