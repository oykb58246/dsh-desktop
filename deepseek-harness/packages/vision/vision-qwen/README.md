# @deepseek-ai/dsh-vision-qwen

Built-in Qwen-VL vision bridge for the DeepSeek Harness, modelled on the
vision capability of [QwenLM/Qwen-MM-Plugins](https://github.com/QwenLM/Qwen-MM-Plugins)
(Apache-2.0): images pasted into a conversation are stored through the
durable attachment seam and, while the selected model cannot read pixels
itself, the `agent/pre-step` seam converts each image block into a stable
text description produced by the Qwen-VL model. Text-only models — DeepSeek
V4 Flash and Pro among them — therefore read what the user attached, and a
companion `vision_chat` tool lets them ask follow-up questions about one
named attachment. A `screenshot` tool goes further: the model can capture
the screen, one window, or a screen region itself, have Qwen-VL analyze it,
and get the answer back as text — tasks that need to "see" the live UI no
longer depend on the user pasting an image.

## Model Experience

- **Model-visible:** each pasted image becomes one text block starting with
  `【图片附件 sha256:<id>】` and carrying the Qwen-VL description, so the
  conversation transcript is reconstructable from the session log alone.
  The prompt section explains the note format and the `vision_chat` tool.
- **Screenshot:** the `screenshot` tool captures the whole (virtual) screen,
  a window (Windows: process name or title substring; macOS: CGWindow id),
  or an absolute screen region, sends the PNG to the configured Qwen-VL
  endpoint, and returns the answer as text; `question` defaults to the
  `describePrompt` full description.
- **Tokens:** one vision call per attached image per step; each call sends
  the image once to the configured Qwen-VL endpoint. The description text
  counts toward the text model's context window. The screenshot tool costs
  one vision request per invocation.
- **KV-cache:** none beyond the harness's own history reuse; the bridge
  keeps a bounded runtime-only recall of recent attachments (64) for
  `vision_chat`, never persisted.

## Configuration

All fields are optional (`vision-qwen` settings section, layered over the
composition entry):

```yaml
- id: vision-qwen
  config:
    enabled: true   # default true
    baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
    model: qwen-vl-max-latest
    apiKeyEnv: DASHSCOPE_API_KEY
    describePrompt: ...
```

The API key resolves through the credential seam (`DASHSCOPE_API_KEY` in the
environment, `$DSH_HOME/.env`, or the web credentials store). With the
bridge enabled the host's prompt admission accepts images for text-only
models; disabling it restores the strict image gates.

## Known Limitations and Deferred Work

- A pasted image is visible in the transcript as its description, not as the
  stored picture; sessions that already contain raw image blocks (sent
  through a native vision model) still fail mid-turn when a text-only model
  is selected afterwards.
- The vision endpoint is fixed to an OpenAI-compatible chat-completions
  route; streaming vision responses are not consumed (the bridge waits for
  the complete answer).
- `screenshot` window capture depends on the target window being readable
  through `PrintWindow`/`GetWindowRect` (Windows); occluded windows prefer
  the full-content `PrintWindow` render and fall back to a screen-region
  copy. Linux requires ImageMagick's `import` command.
