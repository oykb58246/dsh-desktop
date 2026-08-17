/**
 * Built-in Qwen-VL vision bridge, modelled on the Qwen-MM-Plugins vision
 * capability (https://github.com/QwenLM/Qwen-MM-Plugins, Apache-2.0):
 * images pasted into a conversation are saved through the durable attachment
 * seam and, while the selected model cannot read pixels itself, the
 * `agent/request-messages` seam converts each image block into a stable text
 * description produced by the Qwen-VL model for the model request only — the
 * durable user/message keeps the original image so the UI can show it
 * immediately. Text-only models — DeepSeek
 * V4 Flash and Pro among them — therefore read what the user attached, and a
 * companion `vision_chat` tool lets them ask follow-up questions about one
 * named attachment. A `screenshot` tool additionally lets the model capture
 * the screen, a window, or a region itself and have the vision model analyze
 * it, so tasks that need to "see" the live UI never depend on the user
 * pasting an image.
 *
 * The plugin layers its `cordis.yml` entry config under the optional
 * `vision-qwen` user-settings section and resolves the DashScope key through
 * the optional credential seam, so enabling/disabling, endpoint, model, and
 * key reach the next turn without a restart. It also provides the `vision`
 * service, which the host's prompt admission consults before refusing image
 * input for a text-only model.
 *
 * @module @deepseek-ai/dsh-vision-qwen
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmRuntime, Message } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { CaptureRequest } from './capture.ts'
import { internals as captureInternals } from './capture.ts'

export const name = 'vision-qwen'
export const inject = ['agents', 'settings', 'credentials', 'tools', 'systemPrompt']

const NS = settingsNamespace('vision-qwen')
const DEFAULT_API_KEY_ENV = 'DASHSCOPE_API_KEY'
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const DEFAULT_MODEL = 'qwen-vl-max'
/** One vision call may take a while on a loaded provider; the caller's signal still wins. */
const VISION_TIMEOUT_MS = 120_000
/** Runtime-only recall of the last rewritten attachments, so `vision_chat` can re-read their bytes. */
const REGISTRY_LIMIT = 64

const DEFAULT_DESCRIBE_PROMPT = '请详细描述这张图片的内容。'
  + '包括：画面中的主要对象、文字（如有，请逐字转录）、布局、颜色，以及任何对理解上下文重要的细节。'
  + '直接用中文回答。'

/** The service the host's prompt admission reads before refusing image input for a text-only model. */
export interface VisionBridge {
  /** Whether the bridge currently accepts and describes attached images. */
  enabled(): boolean
}

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `vision-qwen` settings-section shape. Every field is optional in yml:
 * a missing key resolves through {@link Config.apiKeyEnv} per call, a missing
 * endpoint/model uses the public DashScope OpenAI-compatible route, and a
 * missing switch keeps the bridge enabled.
 */
export interface Config {
  /** Whether the bridge is on (default true). */
  enabled?: boolean
  /** OpenAI-compatible endpoint base; `/chat/completions` is appended. */
  baseURL?: string
  /** Wire vision-model id served by the endpoint. */
  model?: string
  /** Credential reference (environment-variable name) resolved per call; defaults to `DASHSCOPE_API_KEY`. */
  apiKeyEnv?: string
  /** Prompt used to describe one pasted image. */
  describePrompt?: string
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean(),
  baseURL: z.string(),
  model: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  describePrompt: z.string(),
})

/** Resolved, validated per-call facts; a rejected snapshot keeps the last good one. */
interface ResolvedConfig {
  enabled: boolean
  baseURL: string
  model: string
  apiKeyEnv: string
  describePrompt: string
}

/** Validate and default one config snapshot, failing loud for the composition entry. */
function resolveConfig(config: Config): ResolvedConfig {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  if (baseURL.length === 0) throw new Error('vision-qwen: baseURL must not be empty')
  const model = config.model ?? DEFAULT_MODEL
  if (model.length === 0) throw new Error('vision-qwen: model must not be empty')
  return {
    enabled: config.enabled ?? true,
    baseURL,
    model,
    apiKeyEnv: config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    describePrompt: config.describePrompt ?? DEFAULT_DESCRIBE_PROMPT,
  }
}

/** Map an HTTP status to a stable LlmError code. */
function httpCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** Render the durable note that replaces one image block in a user message. */
function renderImageNote(ref: ImageAttachmentRef, body: string, failed: boolean): string {
  const head = `【图片附件 ${ref.attachmentId}】`
  if (failed) return `${head}图片内容描述生成失败：${body}`
  return `${head}图片内容（由内置 Qwen-VL 视觉插件自动转换）：\n\n${body}\n\n`
    + `如需进一步分析此图，可调用 vision_chat 工具（attachment_id="${ref.attachmentId}"）。`
}

/** Extract the text answer from an OpenAI-compatible chat completion payload. */
function answerOf(payload: unknown): string {
  const value = payload as { choices?: unknown }
  const first = Array.isArray(value.choices) ? value.choices[0] : undefined
  const message = first as { message?: { content?: unknown } } | undefined
  const content: unknown = message?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts = content.flatMap(part => {
      const text = (part as { text?: unknown })?.text
      return typeof text === 'string' ? [text] : []
    })
    const joined = parts.join('').trim()
    if (joined.length > 0) return joined
  }
  return ''
}

/**
 * Call the configured Qwen-VL endpoint for one image over the OpenAI-compatible
 * protocol (`{baseURL}/chat/completions`). The user must supply an
 * OpenAI-compatible DashScope address (e.g. `…/compatible-mode/v1`).
 * @param config - the resolved per-call facts.
 * @param apiKey - the bearer token resolved for this call.
 * @param mediaType - the stored image's declared media type.
 * @param data - the stored image bytes.
 * @param prompt - the question to answer about the image.
 * @param signal - caller cancellation.
 * @returns the model's text answer.
 */
async function askVision(
  config: ResolvedConfig,
  apiKey: string,
  mediaType: string,
  data: Uint8Array,
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const base64 = Buffer.from(data).toString('base64')
  const upstream = signal === undefined
    ? AbortSignal.timeout(VISION_TIMEOUT_MS)
    : AbortSignal.any([signal, AbortSignal.timeout(VISION_TIMEOUT_MS)])
  const url = `${config.baseURL.replace(/\/+$/u, '')}/chat/completions`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
            { type: 'text', text: prompt },
          ],
        }],
        stream: false,
      }),
      signal: upstream,
      // A provider request carrying a bearer key must never follow a redirect.
      redirect: 'error',
    })
  } catch (error: unknown) {
    if (signal?.aborted === true) throw new LlmError('vision-qwen: request aborted by caller', 'ABORTED', { cause: error })
    throw new LlmError(`vision-qwen: request to ${url} failed`, 'TRANSPORT', { cause: error })
  }
  if (!response.ok) {
    let message = `vision-qwen: HTTP ${response.status}`
    try {
      const parsed = await response.json() as { error?: { message?: string } }
      if (parsed.error?.message) message = parsed.error.message
    } catch {
      // Only swallow error-body parsing: the HTTP status still identifies the failure.
    }
    throw new LlmError(message, httpCode(response.status), { status: response.status })
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error: unknown) {
    throw new LlmError('vision-qwen: provider returned an unreadable response body', 'TRANSPORT', { cause: error })
  }
  const answer = answerOf(payload)
  if (answer.length === 0) throw new LlmError('vision-qwen: provider returned no text answer', 'EMPTY_RESPONSE')
  return answer
}

/** Flatten one failure for a durable note. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register the vision bridge: the `vision` service, the per-attachment
 * follow-up tool, the durable image-description rewrite on `agent/pre-step`,
 * and the model-facing prompt section.
 * @param ctx - plugin context; every registration is disposed with it.
 * @param config - composition entry config, layered under the settings section.
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedConfig | undefined
  const resolved = (): ResolvedConfig => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveConfig(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('vision-qwen: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  let enabled = resolved().enabled
  const bridge: VisionBridge = {
    enabled: () => enabled,
  }
  ctx.provide('vision', bridge)

  // Runtime-only attachment recall for `vision_chat`: a rewritten message no
  // longer carries its image block, so the tool re-reads the bytes from here.
  const recentRefs = new Map<string, ImageAttachmentRef>()
  /** Full 【图片附件 …】 notes, reused when the same image is projected again. */
  const descriptionCache = new Map<string, string>()

  const remember = (ref: ImageAttachmentRef): void => {
    recentRefs.set(String(ref.attachmentId), ref)
    if (recentRefs.size > REGISTRY_LIMIT) {
      const oldest = recentRefs.keys().next().value
      if (oldest !== undefined) recentRefs.delete(oldest)
    }
  }

  const attachments = (): AttachmentStore | undefined => ctx.get('attachments') as AttachmentStore | undefined

  const resolveApiKey = async (): Promise<string> => {
    const ref = credentialRef(resolved().apiKeyEnv)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && hit.value.length > 0) return hit.value
    }
    throw new LlmError(
      `vision-qwen: no API key for the Qwen-VL bridge; store ${resolved().apiKeyEnv} through the credentials`
      + ' service, write it into $DSH_HOME/.env, or export it in the launching environment',
      'MISSING_CREDENTIAL',
    )
  }

  /** Find the durable ref for one attachment id, recent rewrites first. */
  function findRef(agent: Agent | undefined, attachmentId: string): ImageAttachmentRef | undefined {
    const remembered = recentRefs.get(attachmentId)
    if (remembered !== undefined) return remembered
    for (const event of agent?.session.events ?? []) {
      // Attached images only ever enter through user/assistant messages; the
      // tool-result nesting a tool may produce is never a pasted attachment.
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
      const blocks = event.type === 'user/message' ? event.data.content : event.data.message.content
      for (const block of blocks) {
        if (block.type === 'image' && String(block.attachment.attachmentId) === attachmentId) {
          return block.attachment
        }
      }
    }
    return undefined
  }

  /** Whether the route this step will use reads pixels itself. */
  async function modelAcceptsImages(agent: Agent): Promise<boolean> {
    const header = agent.session.requestHeader()?.config
    const provider = header?.provider ?? agent.options.provider
    const model = header?.model ?? agent.options.model
    if (!provider || !model) return false
    const llm = ctx.get('llm') as LlmRuntime | undefined
    if (llm === undefined) return false
    try {
      const info = await llm.resolveModelInfo(provider, model)
      return info.inputModalities?.includes('image') ?? false
    } catch {
      // An unresolvable route is not image-capable from the bridge's view.
      return false
    }
  }

  /** Convert one image block into the request-only description note. */
  async function translateBlock(block: Extract<ContentBlock, { type: 'image' }>, signal: AbortSignal): Promise<string> {
    const ref = block.attachment
    const id = String(ref.attachmentId)
    const cached = descriptionCache.get(id)
    if (cached !== undefined) return cached
    remember(ref)
    try {
      const store = attachments()
      if (store === undefined) {
        throw new LlmError('vision-qwen: the durable attachment service is unavailable', 'UNSUPPORTED_CONTENT')
      }
      const stored = await store.readImage(ref, signal)
      const key = await resolveApiKey()
      const description = await askVision(
        resolved(), key, stored.ref.mediaType, stored.data, resolved().describePrompt, signal,
      )
      const note = renderImageNote(ref, description, false)
      descriptionCache.set(id, note)
      return note
    } catch (error: unknown) {
      const note = renderImageNote(ref, messageOf(error), true)
      descriptionCache.set(id, note)
      return note
    }
  }

  function stubNote(block: Extract<ContentBlock, { type: 'image' }>): string {
    const id = String(block.attachment.attachmentId)
    const cached = descriptionCache.get(id)
    if (cached !== undefined) {
      return `${cached}\n（像素未再次发送；如需重看请调用 vision_chat，attachment_id="${id}"。）`
    }
    return `【图片附件 ${id}】此前已发送过此图。如需重看请调用 vision_chat（attachment_id="${id}"）。`
  }

  async function projectMessages(
    messages: readonly Message[],
    acceptImages: boolean,
    signal: AbortSignal,
  ): Promise<Message[]> {
    let lastImageUser = -1
    if (acceptImages) {
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index]
        if (message?.role === 'user' && contentHasImage(message.content)) lastImageUser = index
      }
    }
    const projected: Message[] = []
    let changed = false
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]
      if (message === undefined) continue
      if (!contentHasImage(message.content)) {
        projected.push(message)
        continue
      }
      const keepPixels = acceptImages && index === lastImageUser
      const content: ContentBlock[] = []
      for (const block of message.content) {
        if (block.type !== 'image') {
          content.push(block)
          continue
        }
        remember(block.attachment)
        if (keepPixels) {
          content.push(block)
          continue
        }
        changed = true
        const text = acceptImages
          ? stubNote(block)
          : await translateBlock(block, signal)
        content.push({ type: 'text', text })
      }
      projected.push({ ...message, content })
    }
    return changed ? projected : [...messages]
  }

  ctx.on('agent/request-messages', async (
    { agent, signal, messages },
    next,
  ): Promise<Message[]> => {
    const incoming = await next()
    if (!enabled || signal.aborted) return incoming
    const source = incoming.length > 0 ? incoming : messages
    if (!source.some(message => contentHasImage(message.content))) return incoming
    return projectMessages(source, await modelAcceptsImages(agent), signal)
  }, { prepend: true })

  const visionChatTool = defineTool({
    name: 'vision_chat',
    description:
      'Ask the Qwen-VL vision model a specific question about one image the user attached in this conversation. '
      + 'Only use this for follow-up questions about an image already described by a 【图片附件 …】 note, '
      + 'or about an image block present in the session. Use the attachment id as shown in the note.',
    parameters: {
      attachment_id: {
        type: 'string',
        required: true,
        description: 'The attachment id shown in the 【图片附件 sha256:…】 note or in the image block.',
      },
      question: {
        type: 'string',
        required: true,
        description: 'A specific question about the image, e.g. "What does the text in the top-right corner say?"',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.description }],
    },
    async execute(args, exec: ToolExecution) {
      const ref = findRef(exec.agent, args.attachment_id)
      if (ref === undefined) {
        return {
          description: `vision-qwen: attachment "${args.attachment_id}" is not present in this session.`,
        }
      }
      const store = attachments()
      if (store === undefined) {
        return { description: 'vision-qwen: the durable attachment service is unavailable.' }
      }
      try {
        const stored = await store.readImage(ref, exec.signal)
        const key = await resolveApiKey()
        const answer = await askVision(resolved(), key, stored.ref.mediaType, stored.data, args.question, exec.signal)
        return { description: answer }
      } catch (error: unknown) {
        return { description: `vision-qwen: ${messageOf(error)}` }
      }
    },
  })

  const screenshotTool = defineTool({
    name: 'screenshot',
    description:
      'Capture the screen, a specific window, or a screen region and analyze the image with the Qwen-VL vision model. '
      + 'Use this when the task requires seeing the current screen, a window, or a UI region (for example checking '
      + 'a page, a dialog, or an application state). The captured image is sent to the configured vision model and '
      + 'the answer comes back as text.',
    parameters: {
      target: {
        type: 'string',
        enum: ['screen', 'window'],
        description: 'What to capture: the whole (virtual) screen, or a single window. Defaults to "screen".',
      },
      window: {
        type: 'string',
        description: 'The window to capture when target is "window": a process name or window-title substring (Windows), or a CGWindow id (macOS).',
      },
      region: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'number', required: true, description: 'Left edge of the region, in virtual-screen pixels.' },
          y: { type: 'number', required: true, description: 'Top edge of the region, in virtual-screen pixels.' },
          width: { type: 'number', required: true, description: 'Region width in pixels (positive).' },
          height: { type: 'number', required: true, description: 'Region height in pixels (positive).' },
        },
        description: 'An absolute screen region {x, y, width, height}; overrides target.',
      },
      question: {
        type: 'string',
        description: 'The specific question about the capture; defaults to a full description of the image.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.description }],
    },
    async execute(args, exec: ToolExecution) {
      const question = typeof args.question === 'string' && args.question.trim() !== ''
        ? args.question.trim()
        : resolved().describePrompt
      const request: CaptureRequest = { target: args.target ?? 'screen' }
      if (typeof args.window === 'string' && args.window.trim() !== '') request.window = args.window
      if (args.region !== undefined) request.region = args.region
      try {
        const bytes = await captureInternals.capture(request, exec.signal)
        const key = await resolveApiKey()
        const answer = await askVision(resolved(), key, 'image/png', bytes, question, exec.signal)
        return { description: answer }
      } catch (error: unknown) {
        return { description: `screenshot: ${messageOf(error)}` }
      }
    },
  })

  let toolDisposer: (() => void) | undefined
  const syncRegistrations = (): void => {
    enabled = resolved().enabled
    toolDisposer?.()
    if (!enabled) {
      toolDisposer = undefined
      return
    }
    const disposers = [
      ctx.tools.register(visionChatTool),
      ctx.tools.register(screenshotTool),
    ]
    toolDisposer = () => disposers.forEach(dispose => dispose())
  }
  syncRegistrations()

  ctx.systemPrompt.section({
    name: 'vision:qwen',
    order: 115,
    text: 'When a user message contains a 【图片附件 …】 note, the attached image has already been converted '
      + 'into a text description inside that note. Treat the description as the image content. '
      + 'If you need further detail about that image, call the vision_chat tool with its attachment id '
      + 'and a specific question. '
      + 'When the task requires seeing the current screen, a window, or a UI region — for example checking '
      + 'a page, a dialog, or an application state — call the screenshot tool yourself; the captured image '
      + 'is analyzed by the vision model and comes back as text.',
  })

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: syncRegistrations,
  })
}

/**
 * Test hook mirroring the web-app precedent: the `screenshot` tool routes its
 * capture through here, so tests can stub the platform capture on any host.
 * This IS the capture module's internals object — mutating `capture` here
 * swaps the exact function the tool calls.
 */
export const internals = captureInternals
