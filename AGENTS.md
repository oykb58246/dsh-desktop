# AGENTS.md — dsh-desktop 开发提醒

## 打包安装器：只用 Go 原生方案，勿改用其他方式

**硬性规则**：打包安装器**只能**用 `loader/main.go`（Go 原生 Win32 安装器）+
`scripts/append-payload.mjs`。唯一入口是 `pnpm dist:win`。

**禁止**（都是历史弃用路线）：

- 禁止 electron-builder 的 `portable` / `nsis` 目标
- 禁止重新引入 NSIS 脚本
- 禁止任何压缩

改动打包流程前，**先读 [INSTALLER.md](INSTALLER.md)**，不要凭 electron-builder
默认经验另起炉灶。该文档记录完整容器格式、UI 规范与全部踩坑。

## 其他反复强调过的约定（速查）

- **effort（推理强度）取值永远用英文**：`low / high / xhigh / max / ultra`，中文英文界面都一样。
- **视觉插件只支持 OpenAI 兼容协议**；默认模型 `qwen-vl-max`（`-latest` 别名会 403）。
- **Codex 导入不复制文件**：注册工作区引用原目录 + 导入会话；同名不同目录的已导入项目可重复导入。
- 仓库作者只有 oykb（单一作者）；官方下载站 `ds.oykb.cn`。
