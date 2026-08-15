# Agent Note: vision-qwen screenshot tool

Status: implemented

English | [中文](2026-08-15-vision-screenshot-tool.zh.md)

## Problem

Qwen-VL 视觉桥（`@deepseek-ai/dsh-vision-qwen`）此前只处理用户粘贴进会话的图片：
`agent/pre-step` 把粘贴的图片块改写为文字描述，`vision_chat` 针对这些具名附件追问
细节。没有任何机制让模型自己截取实时屏幕，因此凡是需要检查当前界面（页面、对话框、
应用状态）的任务都会因为没有可用工具而卡死。整个 harness 也本就不存在任何截屏能力
（`screenshot` 只作为提示词里的一个词出现）。

## Decision

插件现在与 `vision_chat` 并列注册 `screenshot` 工具（两者共用同一个 `enabled` 开关）：
模型可以截取整个虚拟屏幕、单个窗口或绝对屏幕区域，把 PNG 送进现有的 `askVision`
管道（配置的 Qwen-VL 端点、凭据缝、`describePrompt` 缺省），以文本收到答案——
与粘贴图片注记完全相同的纯文本模型契约。

截图后端位于 `src/capture.ts`，经 `internals.capture` 钩子可替换（沿用 web-app
`internals` 先例），测试可在任意主机上桩掉平台截图：

- **Windows：** 每次请求构造一段 PowerShell + System.Drawing 脚本——屏幕/区域用
  `CopyFromScreen` 覆盖虚拟屏幕（`GetSystemMetrics` 76–79）；窗口捕获按进程名或
  标题子串匹配，用 `PrintWindow`（PW_RENDERFULLCONTENT）渲染，失败回退到
  屏幕区域 `CopyFromScreen`。
- **macOS：** `screencapture`（`-R` 区域、`-l` 窗口 id）。
- **Linux：** ImageMagick `import -window root`（区域用 `-crop`）。

面向模型的提示词段现在明确告诉模型：需要看实时界面时自行调用 `screenshot`。

## Alternatives considered

**由 Electron 壳经 `desktopCapturer` 搭桥。** 否决：harness 是与 Electron 壳分离的
独立 Node 进程，工具需要新增壳↔harness 通道（IPC 或 HTTP 路由），而且该能力在
harness 的纯 Web GUI 部署中根本不存在。

**为屏幕捕获引入 Node 原生插件。** 否决：为一个工具引入编译期依赖不成比例；平台
自带 CLI 已覆盖 Windows/macOS/Linux，包内零原生代码。

**把截图持久化为持久附件，供 `vision_chat` 回溯。** 暂缓：对纯文本模型而言描述文本
就是交付物，`vision_chat` 的召回是受限的运行时映射，附件持久化只会增加会话日志
负担且没有当前消费者。若出现"对截图追问"的真实用例再重新评估。

## Consequences

- 纯文本模型可以自助完成屏幕检查：每次捕获一次 `screenshot` 调用、每次调用一次
  视觉请求，不再需要用户手动贴图。
- 每次捕获要付出一次 PowerShell/screencapture/import 进程启动（Windows 约 1–2 秒）
  加一次 Qwen-VL 请求；失败像插件其余部分一样以描述文本呈现。
- 窗口捕获质量取决于目标窗口能否被 `PrintWindow`/`GetWindowRect` 读取；被遮挡的
  窗口优先全内容渲染，失败回退屏幕区域拷贝。
- Linux 依赖 ImageMagick 的 `import`；否则工具干净地报错。
- 工具随 harness 运行时重建（`prepare:runtime` + 安装器）交付——桌面端当前运行
  的实例在下次更新前仍是旧插件。
