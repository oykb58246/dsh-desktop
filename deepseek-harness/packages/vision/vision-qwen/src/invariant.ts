/**
 * Package-owned durable invariants for the Qwen-VL vision bridge: every user
 * message carrying a 【图片附件 …】 note must have had its image blocks
 * converted, so the text-only model face is reconstructable from the log.
 * @module @deepseek-ai/dsh-vision-qwen/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

const PACKAGE_NAME = '@deepseek-ai/dsh-vision-qwen'
const NOTE_HEAD = /^【图片附件 (sha256:[0-9a-f]{64})】/

/** Cordis companion plugin name. */
export const name = 'vision-qwen-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one user message that was rewritten by the vision bridge. */
function validateMessage(
  message: SessionEvent<'user/message'>['data'],
  fail: InvariantFailure,
): void {
  const blocks = message.content as readonly ContentBlock[]
  const notes = blocks.filter(block =>
    block.type === 'text' && NOTE_HEAD.test(block.text),
  )
  if (notes.length === 0) return
  if (blocks.some(block => block.type === 'image')) {
    fail('a vision-qwen note must never share its user message with an image block')
  }
  for (const note of notes) {
    const block = note as { type: 'text'; text: string }
    const match = NOTE_HEAD.exec(block.text)
    /* v8 ignore next -- the preceding fixed regexp always supplies the capture group. */
    if (match === null) continue
    const id = match[1]
    if (!block.text.includes(`attachment_id="${id}"`)) {
      fail(`vision-qwen note for ${id} must name its attachment id in the follow-up instruction`)
    }
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate all package-owned notes already present in one session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const event of session.events) {
    if (event.type !== 'user/message') continue
    validateMessage(event.data, fail)
  }
}

/** Install validation for loaded and newly appended rewritten messages. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [_session, event] = args as [Session, SessionEvent]
    if (event.type !== 'user/message') return
    validateMessage(event.data, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the vision-qwen invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
