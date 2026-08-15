# dsh-desktop

Electron desktop shell for the official `deepseek-harness` web app.

## Run

```powershell
pnpm install
pnpm start
```

On first launch, the app checks `deepseek-harness` automatically:

- installs workspace dependencies when `node_modules` is missing
- builds the harness when the web and CLI artifacts are missing
- starts `pnpm dsh web --host 127.0.0.1 --port 0`

The embedded web app then opens inside Electron.

## 打包

```powershell
pnpm dist:win
```

`prepare:runtime`（`scripts/prepare-runtime.mjs`）会先构建本地 `deepseek-harness`
源码，再下载 `upstream.lock.json` 锁定的 npm 内核作为依赖树，然后把本地构建
产物（全部 `@deepseek-ai/dsh-*` 包的 `lib/` 与 Web 前端 `dist/`）覆盖到内核上，
因此安装包内置的是本仓库的 harness（含视觉插件与模型设置改动），而不是纯
npm 快照。

## 工具区（标题栏扳手入口）

标题栏右侧窗口按钮（`- □ ×`）左侧的扳手打开独立的工具窗口
（`electron/tools.html`，多工具工作台，左侧菜单切换工具）：

**Codex 项目导入**（`electron/codex-import.mjs`）

- 只读扫描用户选择的 Codex 工作区，识别项目标记（`package.json`、
  `Cargo.toml`、`pyproject.toml` 等），跳过 `node_modules`/`dist`/`target` 等目录
- 列出每个项目目录下匹配的 Codex 历史会话（`rollout-*.jsonl` +
  `session_index.jsonl`，双向路径归属匹配）
- 冲突预检：目标目录同名项目、已导入会话
- 复制项目到用户选择的 Harness 项目目录
- 把勾选的 Codex 会话转换为 dsh 会话日志（`user/message`、
  `assistant/message`、`tool/result` 事件，seq 连续，`surfaceOp` 齐全），
  以 zstd 帧写入 `$DSH_HOME/sessions/<projectKey>/<sessionId>/session.jsonl.zstd`
- 通过 dsh web 的 JSON-RPC API 注册复制后的项目目录为工作区

会话日志格式与 `deepseek-harness` 的 JSONL 持久化后端兼容（header 独立
zstd 帧 + 事件帧，`node:zlib` 原生编码），导入后主窗口刷新即可在侧边栏
看到迁移的会话并可浏览历史。

**检查更新**（`electron/updater.mjs`）

- 对照官方仓库基线（`website/download/latest.yml`，GitHub Releases 兜底）
  检查新版本，显示当前版本、官方基线版本与内置内核 `@deepseek-ai/dsh` 版本
- 一键下载安装包（sha512 校验），通过安装器 worker 覆盖安装并重启
- 开发模式（未打包）只做检查，不提供自动更新

**视觉插件**（`deepseek-harness/packages/vision/vision-qwen` + 工具区面板）

- 内置 Qwen-VL 视觉桥，设计参考 [QwenLM/Qwen-MM-Plugins](https://github.com/QwenLM/Qwen-MM-Plugins)
  （Apache-2.0）：聊天中粘贴的图片由 Qwen-VL 转成文字描述后交给所选模型，
  `deepseek-v4-flash` 与 `deepseek-v4-pro` 都能直接理解图片；模型还可以用
  `vision_chat` 工具针对某张图片追问细节
- 工具区「视觉插件」页提供开关（默认开启）、DashScope API Key（含「获取 API Key」
  一键跳转百炼控制台）、视觉模型与 API 地址配置，并留有 Qwen-MM-Plugins / 通义千问的
  版权备注
- 开关、模型与地址写入 `$DSH_HOME/cordis.patch.yml`（热更新生效）；密钥写入
  `$DSH_HOME/.credentials.yaml`（本地凭据提供器监听该文件，**实时生效**，无需重启），
  同时写入 `$DSH_HOME/.env` 作为启动兜底
- API 地址使用 **OpenAI 协议**（以 `/compatible-mode/v1` 结尾）：请在百炼控制台创建
  接入点时选择「OpenAI 兼容」协议，把生成的地址填入

**归档管理**（`deepseek-harness/packages/workspace` + 工具区面板）

- 侧边栏工作区「删除工作区」改为「归档工作区」：归档后工作区及其下会话从前端
  隐藏，但工作区记录与会话日志完整保留
- 工具区「归档管理」页列出已归档的工作区与单独归档的会话，可一键恢复
- 归档/恢复经 harness 的 `workspace.archive` / `workspace.unarchive` /
  `workspace.unarchiveSession` / `workspace.listArchived` RPC

**界面体验**

- 主窗口与工具区窗口均支持文本选区 + 右键复制 / 粘贴 / 剪切 / 全选

IPC 面：`electron/main.mjs`（`codex-import-*`、`update:*`、`installer:*`、
`vision:*`、`archive:*`、`open-external` handlers）、`electron/preload.mjs`
（`window.dshDesktop`）。

## 安装器流程（三步）

安装器是 **Go 原生 Win32 可执行程序**（`loader/main.go`），双击秒开、无压缩，
数据以追加字节封进 exe、安装时直接解压到所选目录，界面与 Electron 保持一致的
海洋蓝主题。三步：选路径 → 安装进度（按文件数统计）→ 完成（默认勾选启动）。

打包唯一入口 `pnpm dist:win`，完整设计、容器格式与踩坑见
[INSTALLER.md](INSTALLER.md)。
