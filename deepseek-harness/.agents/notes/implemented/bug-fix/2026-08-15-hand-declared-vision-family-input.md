# Agent Note: Hand-declared vision family input

Status: implemented

English | [中文](2026-08-15-hand-declared-vision-family-input.zh.md)

## Problem

`vision-qwen` already leaves image blocks alone when `resolveModelInfo` reports `image` in `inputModalities`. A hand-declared model that names no `input` falls through to the route `defaultInput` of `[text]`. Connecting a multimodal gateway model such as `grok-4.6` — a sibling of shipped `grok-4.5` — therefore still rewrote every pasted picture into a Qwen-VL text note and offered `vision_chat`, instead of sending the pixels to the selected model.

## Decision

Request-modality resolution is entry `input` → same-route catalog entry → a catalog-wide hint → route `defaultInput`. `catalogInputHint` in `packages/llm/llm-pi-ai/src/catalog.ts` supplies that hint: an exact id on any installed catalog route wins; otherwise a family (`grok` / `claude` / `gemini` / `gemma`) in which every installed sibling already accepts images yields `[text, image]`. Image-generation ids containing `imagine`, and families with any text-only sibling, state no answer so the conservative route default remains. An explicit `input: [text]` still forces text-only.

The Models page stores the same claim when the user ticks **Accepts images** or adopts a `grok` / `claude` / `gemini` / `gemma` / `vl` / `vision` candidate. That write is optional: the adapter hint already serves an existing `grok-4.6` row that never declared `input`.

## Alternatives considered

**Require every hand-declared vision model to set `input: [text, image]`.** The field already existed and the README already documented it. Users connecting a gateway never saw it, and the vision bridge treated silence as text-only, so the documented path did not reach the product they used.

**Set route `defaultInput: [text, image]` for every custom provider.** A mixed gateway would then send images to text-only siblings and fail mid-turn after the message was durable — the cost the conservative default exists to avoid.

**Guess from listing metadata only.** CodexAuv's `/v1/models` row for `grok-4.6` disclosed no vision flag. Adoption-time listing parse would not have fixed the already-saved row.

## Consequences

A newer sibling of a shipped vision family accepts pasted images without a hand-written `input` list, and the vision bridge stays out of that turn. Over-claiming is limited to families the installed catalog already records as unanimous vision; a later text-only sibling in that family turns the hint off. An explicit `input` on the entry still wins.
