# Agent Note: vision-qwen screenshot tool

Status: implemented

English | [中文](2026-08-15-vision-screenshot-tool.zh.md)

## Problem

The Qwen-VL vision bridge (`@deepseek-ai/dsh-vision-qwen`) only handled images
the user pasted into the conversation: `agent/pre-step` rewrote pasted image
blocks into text descriptions and `vision_chat` answered follow-ups about those
named attachments. Nothing let the model capture the live screen, so any task
that required checking the current UI — a page, a dialog, an application
state — dead-ended with no tool to call. The harness contained no screenshot
capability anywhere (`screenshot` appeared only as a word in a prompt section).

## Decision

The plugin now registers a `screenshot` tool alongside `vision_chat` (both
gated by the same `enabled` switch): the model can capture the whole virtual
screen, a single window, or an absolute screen region, send the PNG through
the existing `askVision` pipeline (configured Qwen-VL endpoint, credential
seam, `describePrompt` default), and receive the answer as text — the same
text-only-model contract as pasted-image notes.

The capture backend lives in `src/capture.ts`, swapped through an
`internals.capture` hook (mirroring the web-app `internals` precedent) so
tests stub the platform capture on any host:

- **Windows:** one PowerShell + System.Drawing script built per request —
  `CopyFromScreen` over the virtual screen (`GetSystemMetrics` 76–79) for
  screen/region; window capture matches a process name or a title substring
  and renders through `PrintWindow` (PW_RENDERFULLCONTENT) with a
  screen-region `CopyFromScreen` fallback.
- **macOS:** `screencapture` (`-R` region, `-l` window id).
- **Linux:** ImageMagick `import -window root` (region via `-crop`).

The model-facing prompt section now tells the model to call `screenshot`
itself when the task needs to see the live UI.

## Alternatives considered

**Electron `desktopCapturer` bridge from the shell.** Rejected: the harness
runs as a separate Node process from the Electron shell, so the tool would
need a new shell↔harness channel (IPC or an HTTP route), and the capability
would not exist for web-GUI deployments of the harness at all.

**A Node native addon for screen capture.** Rejected: a compiled dependency
for one tool is disproportionate; the platform CLIs already cover Windows,
macOS, and Linux with zero native code in the package.

**Persist captures as durable attachments so `vision_chat` can revisit
them.** Rejected for now: the description text is the deliverable for
text-only models, `vision_chat`'s recall is a bounded runtime map, and
attachment persistence would add session-log weight without a current
consumer. Revisit if a follow-up-on-capture use case appears.

## Consequences

- Text-only models can self-serve screen checks: one `screenshot` call per
  capture, one vision request per call, no user paste required.
- Each capture costs a PowerShell/screencapture/import spawn (~1–2 s on
  Windows) plus one Qwen-VL request; the tool surfaces failures as
  descriptions like the rest of the plugin.
- Window capture quality depends on the target window being readable through
  `PrintWindow`/`GetWindowRect`; occluded windows prefer the full-content
  render and fall back to a screen-region copy.
- Linux requires ImageMagick's `import`; the tool errors cleanly otherwise.
- Shipping the tool requires rebuilding the harness runtime
  (`prepare:runtime` + installer) — the desktop app's running instance keeps
  the old plugin until the next update.
