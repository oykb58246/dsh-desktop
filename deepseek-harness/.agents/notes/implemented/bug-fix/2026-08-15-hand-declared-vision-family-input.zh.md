# Agent Note: Hand-declared vision family input

Status: implemented

[English](2026-08-15-hand-declared-vision-family-input.md) | 中文

## Problem

`vision-qwen` 在 `resolveModelInfo` 报告 `inputModalities` 含 `image` 时本来就会放过图片块。手写模型若未声明 `input`，会落到路由的 `defaultInput` `[text]`。接入多模态网关模型（例如已上架 `grok-4.5` 的兄弟 `grok-4.6`）时，粘贴的图片仍会被改写成 Qwen-VL 文本说明并提供 `vision_chat`，而不是把像素发给当前选中的模型。

## Decision

请求模态的解析顺序是：条目的 `input` → 同路由 catalog 条目 → catalog 范围的提示 → 路由的 `defaultInput`。`packages/llm/llm-pi-ai/src/catalog.ts` 中的 `catalogInputHint` 提供该提示：任一已安装 catalog 路由上的精确 id 优先；否则若某个家族（`grok` / `claude` / `gemini` / `gemma`）的每个已安装兄弟都已接受图片，则给出 `[text, image]`。含 `imagine` 的图像生成 id，以及存在任一纯文本兄弟的家族，不作答，因而仍走保守的路由默认值。显式的 `input: [text]` 仍可强制纯文本。

模型设置页在用户勾选「支持图片输入」，或采纳 `grok` / `claude` / `gemini` / `gemma` / `vl` / `vision` 候选时，会写入同一声明。该写入是可选的：适配器提示已经能服务从未声明 `input` 的既有 `grok-4.6` 行。

## Alternatives considered

**要求每个手写视觉模型都设置 `input: [text, image]`。** 该字段本已存在，README 也已写明。用户接入网关时看不到它，视觉桥又把缺省当成纯文本，因此文档路径到不了他们实际使用的产品。

**给每个自定义提供方设置路由级 `defaultInput: [text, image]`。** 混合网关会把图片发给纯文本兄弟，并在消息已经持久化后于轮次中途失败——这正是保守默认值要避免的代价。

**只从列表元数据猜测。** CodexAuv 的 `/v1/models` 里 `grok-4.6` 一行没有视觉标志。采纳时解析列表也修不好已经存下的行。

## Consequences

已上架视觉家族的更新兄弟无需手写 `input` 即可接受粘贴图片，该轮次不再经过视觉桥。过度声明仅限于已安装 catalog 已记录为全体视觉的家族；该家族日后若出现纯文本兄弟，提示会关闭。条目上的显式 `input` 仍然优先。
