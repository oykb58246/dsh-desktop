import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as visionQwen from '@deepseek-ai/dsh-vision-qwen'
import type { Config } from '@deepseek-ai/dsh-vision-qwen'

const PROVIDER = 'mock'
const SIGNAL = new AbortController().signal
const ATTACHMENT_ID = AttachmentId('sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

/** Adapter whose reported input modalities decide whether the bridge translates. */
class TextAdapter extends LlmAdapter {
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'text-only', name: 'Text', inputModalities: ['text'] as const }])
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] as const })
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class VisionAdapter extends LlmAdapter {
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'see', name: 'See', inputModalities: ['text', 'image'] as const }])
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as const })
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function imageMessage(): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{
      type: 'image',
      attachment: {
        attachmentId: ATTACHMENT_ID,
        mediaType: 'image/png',
        bytes: 3,
        width: 1,
        height: 1,
      },
    }],
    source: { kind: 'user' },
  })
}

function sessionAgent(session: Session, model = 'text-only'): Agent {
  return {
    id: SessionId('agent'),
    options: { provider: PROVIDER, model },
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('not used') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function mount(config: Config = {}) {
  const ctx = new Context()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vision-'))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  ctx.provide('credentials', {
    resolve: async (ref: unknown) => ({ ref, value: 'test-key' }),
  })
  ctx.provide('attachments', {
    readImage: async (ref: unknown) => ({ ref, data: new Uint8Array([1, 2, 3]) }),
  })
  await ctx.plugin(visionQwen, config)
  return { ctx }
}

/** Fire one agent/pre-step proposal and return the enter decision's messages. */
async function fire(ctx: Context, agent: Agent) {
  const proposed = imageMessage()
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn: 1, step: 1, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
  )
  if (decision.kind !== 'enter') throw new Error('expected an enter decision')
  return decision.messages
}

function noteText(messages: readonly ReturnType<typeof createUserMessage>[]): string {
  const message = messages[0]
  expect(message).toBeDefined()
  const block = message?.content.find(entry => entry.type === 'text')
  return block?.type === 'text' ? block.text : ''
}

describe('vision-qwen bridge', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '一只猫。' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('provides the vision service and defaults to enabled', async () => {
    const { ctx } = await mount()
    expect((ctx.get('vision') as { enabled(): boolean })?.enabled()).toBe(true)
  })

  it('reflects the disabled switch through the service and skips rewriting', async () => {
    const { ctx } = await mount({ enabled: false })
    expect((ctx.get('vision') as { enabled(): boolean })?.enabled()).toBe(false)
    ctx.llm.registerAdapter([PROVIDER], new TextAdapter())
    const session = Session.create(SessionId('s'))
    const messages = await fire(ctx, sessionAgent(session))
    expect(messages[0]?.content.some(block => block.type === 'image')).toBe(true)
    expect(ctx.tools.schemas().some(schema => schema.name === 'vision_chat')).toBe(false)
  })

  it('converts an image block into a durable vision note for a text-only model', async () => {
    const { ctx } = await mount()
    ctx.llm.registerAdapter([PROVIDER], new TextAdapter())
    const session = Session.create(SessionId('s'))
    const messages = await fire(ctx, sessionAgent(session))
    expect(messages[0]?.content.some(block => block.type === 'image')).toBe(false)
    const text = noteText(messages)
    expect(text).toContain(`【图片附件 ${String(ATTACHMENT_ID)}】`)
    expect(text).toContain('一只猫。')
    expect(text).toContain('vision_chat')
  })

  it('leaves image blocks alone for an image-capable model', async () => {
    const { ctx } = await mount()
    ctx.llm.registerAdapter([PROVIDER], new VisionAdapter())
    const session = Session.create(SessionId('s'))
    const messages = await fire(ctx, sessionAgent(session, 'see'))
    expect(messages[0]?.content.some(block => block.type === 'image')).toBe(true)
  })

  it('degrades to a note naming the failure when the vision call fails', async () => {
    const { ctx } = await mount()
    ctx.llm.registerAdapter([PROVIDER], new TextAdapter())
    globalThis.fetch = vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch
    const session = Session.create(SessionId('s'))
    const messages = await fire(ctx, sessionAgent(session))
    expect(noteText(messages)).toContain('图片内容描述生成失败')
  })

  it('registers vision_chat while enabled', async () => {
    const { ctx } = await mount()
    ctx.llm.registerAdapter([PROVIDER], new TextAdapter())
    const session = Session.create(SessionId('s'))
    await fire(ctx, sessionAgent(session))
    const schema = ctx.tools.schemas().find(entry => entry.name === 'vision_chat')
    expect(schema).toBeDefined()
  })

  it('registers the screenshot tool while enabled and drops it when disabled', async () => {
    const { ctx } = await mount()
    expect(ctx.tools.schemas().some(schema => schema.name === 'screenshot')).toBe(true)
    const disabled = await mount({ enabled: false })
    expect(disabled.ctx.tools.schemas().some(schema => schema.name === 'screenshot')).toBe(false)
  })

  it('runs the screenshot tool end to end with a stubbed capture', async () => {
    const { ctx } = await mount()
    const capture = vi.fn(async () => Buffer.from('fake-png-bytes'))
    const original = visionQwen.internals.capture
    visionQwen.internals.capture = capture
    try {
      const schema = ctx.tools.schemas().find(entry => entry.name === 'screenshot')
      expect(schema).toBeDefined()
      const result = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('shot-1'),
        name: 'screenshot',
        arguments: { target: 'window', window: '记事本', question: '这个窗口里有什么？' },
        agent: sessionAgent(Session.create(SessionId('s'))),
      })
      expect(capture).toHaveBeenCalledWith(
        { target: 'window', window: '记事本', region: undefined },
        expect.anything(),
      )
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text).toContain('一只猫。')
    } finally {
      visionQwen.internals.capture = original
    }
  })

  it('surfaces capture and vision failures as tool descriptions', async () => {
    const { ctx } = await mount()
    const original = visionQwen.internals.capture
    visionQwen.internals.capture = async () => { throw new Error('capture exploded') }
    try {
      const result = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('shot-2'),
        name: 'screenshot',
        arguments: { target: 'screen' },
        agent: sessionAgent(Session.create(SessionId('s'))),
      })
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
      expect(text).toContain('capture exploded')
    } finally {
      visionQwen.internals.capture = original
    }
  })
})
