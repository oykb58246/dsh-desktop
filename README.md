# dsh-desktop

Electron desktop shell for the official `deepseek-harness` web app.

## 官网与下载

在线官网：**[ds.oykb.cn](https://ds.oykb.cn)** —— 支持在线下载最新安装包（Windows 便携安装器），
也可在应用内「工具区 → 检查更新」获取官方发布的最新版本。

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

## 工具区（标题栏扳手入口）

标题栏右侧窗口按钮（`- □ ×`）左侧的扳手打开独立的工具窗口
（`electron/tools.html`，多工具工作台）。当前工具：

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

- 对准官方仓库（`oykb58246/dsh-desktop`）基线：依次读取主分支上由
  `pnpm dist:win` 自动生成的 `website/download/latest.yml`
  （含 version + sha512 + size，为权威基线），失败时回退 GitHub Releases
  的 latest 资产
- 展示当前应用版本、官方基线版本与内置内核（`@deepseek-ai/dsh`）
  版本（内核 npm 最新版仅作参考，内核随应用整体更新）
- 一键更新：下载 `dsh-desktop-setup-x64.exe` → sha512 校验 →
  以 `--installer-worker <安装目录> --relaunch` 提权重跑新构建，
  覆盖安装目录并自动重启（复用安装器 worker，安装目录里被旧进程占用的
  文件带重试等待）；标题栏扳手与工具区入口在发现新版本时显示蓝点
- 发布方式：构建产物推送到官方仓库主分支（或创建 GitHub Release）即
  成为新基线；本地测试可用环境变量
  `DSH_DESKTOP_UPDATE_MANIFEST` 覆盖 latest.yml 地址

IPC 面：`electron/main.mjs`（`codex-import-*`、`update:*` handlers）、
`electron/preload.mjs`（`window.dshDesktop`）。
