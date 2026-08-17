<p align="center">
  <img src="docs/readme/hero.svg" alt="DSH Desktop" width="100%" />
</p>

<p align="center">
  <a href="https://ds.oykb.cn">下载</a>
  ·
  <a href="INSTALLER.md">安装器说明</a>
  ·
  <a href="https://github.com/oykb58246/dsh-desktop">GitHub</a>
  ·
  <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>
</p>

DSH Desktop 把官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 收进桌面窗口：安装后双击即可使用，不必先配 Node 环境、也不必自己拉起 `dsh web`。

Windows 安装包在 [ds.oykb.cn](https://ds.oykb.cn)。

---

## 本地开发

```powershell
pnpm install
pnpm start
```

第一次启动会检查旁边的 `deepseek-harness`：缺依赖就安装，缺构建产物就编译，然后在本机随机端口拉起 Web 服务，再由 Electron 打开。

---

## 功能

<p align="center">
  <img src="docs/readme/tools.svg" alt="工具区：Web 远程控制" width="100%" />
</p>

标题栏窗口按钮左侧的扳手会打开独立的工具窗口。

| | |
|---|---|
| **Codex 项目导入** | 扫描 Codex 工作区，把项目登记为 Harness 工作区，并把勾选的历史会话迁过来。项目文件留在原地，只引用原目录。 |
| **视觉插件** | 聊天里粘贴的图片会先经 Qwen-VL 转成文字，再交给当前模型；也可以针对某张图继续追问。 |
| **归档管理** | 侧边栏里删掉的工作区实际是归档。记录和会话都还在，这里可以恢复。 |
| **侧边卡片** | 管理右侧侧边栏的默认开关、宽度、自动展开和内容页。原先在设置页，现已挪到工具区。 |
| **插件市场** | 浏览 GitHub `dsh-plugin` 并安装到本机 web profile。打包后的桌面端直接从 GitHub 拉仓库，不依赖本机 pnpm。 |
| **Web 远程控制** | 用手机浏览器打开电脑上正在跑的 DSH。同一 Wi-Fi 可直连；也可以走 Cloudflare 隧道，4G / 5G 同样能进。 |
| **检查更新** | 对照发布基线检查新版本。已安装用户优先下载相对上一版的增量包；没有匹配增量包时再下完整安装包。打开安装器后选目录、点安装/更新。不静默覆盖。 |
| **锚定标准 / 路由标准** | 新建会话时可选用的两个社区 Agent 模式。锚定标准先按极简工具面启动，稳住后再按需解锁标准工具；路由标准按任务自动选择规划优先或执行优先的思维模式。 |

主窗口和工具窗口都支持选中文本，以及右键复制、粘贴、剪切、全选。

---

## 安装与打包

安装器是一个 Go 写的 Win32 程序：窗口立刻出来，安装包里的文件不经过压缩，按所选目录直接写出。界面和桌面应用用同一套海洋蓝。

<p align="center">
  <img src="docs/readme/installer.svg" alt="安装流程：选择目录、写入文件、完成" width="100%" />
</p>

流程是三步：选目录，看进度，完成后可选择立刻启动。

<p align="center">
  <img src="docs/readme/architecture.svg" alt="安装包由加载器、Electron 壳和 Harness 运行时组成" width="100%" />
</p>

卸载器在安装目录里的 `Uninstall.exe`。开始菜单的「卸载 DSH Desktop」和 Windows「设置 → 应用」都指向它。对话和设置留在用户目录，不会跟着删掉。

打 Windows 安装包：

```powershell
pnpm dist:win
```

这一步会先构建本地的 `deepseek-harness`，再把它覆盖到锁定版本的 npm 内核上。装出来的应用跑的是这份源码里的 Harness，包括视觉插件和模型设置上的改动。

安装包的文件布局、界面尺寸和实现细节写在 [INSTALLER.md](INSTALLER.md)。

---

## 工具说明

### Codex 项目导入

选一个 Codex 工作区后，会按 `package.json`、`Cargo.toml`、`pyproject.toml` 这类标记找出项目，并配上目录里对得上的历史会话。同名项目、已经导入过的会话会先提示。

导入时不会把项目拷走，只是把原目录登记成工作区，再把勾选的会话写成 Harness 认识的日志。主窗口刷新后，侧边栏里就能看到迁过来的对话。

### 检查更新

更新面板会显示当前版本、发布基线，以及内置的 `@deepseek-ai/dsh` 版本。确认更新后下载安装包（带校验），然后打开安装器——与首次安装完全相同的流程：选目录、点「安装」、完成后可选启动。安装目录默认取上次安装位置，如果 DSH Desktop 正在运行，安装器会先询问是否结束它。

### 视觉插件

默认开启。在工具区填入 DashScope API Key，并指定视觉模型和接口地址。地址需要是 OpenAI 兼容接口（以 `/compatible-mode/v1` 结尾），模型建议用 `qwen-vl-max`。

开关、模型和地址马上生效；密钥写在本机凭据里，改完不必重启。

视觉桥的设计参考了 [QwenLM/Qwen-MM-Plugins](https://github.com/QwenLM/Qwen-MM-Plugins)（Apache-2.0）。

### 归档管理

工作区从侧边栏消失后，记录和会话日志都还留着。工具区可以按工作区或单条会话恢复。

### 侧边卡片

右侧侧边栏（资源管理器、终端、浏览器等）的开关、默认宽度和自动展开，在扳手工具区的「侧边卡片」里改。应用设置页不再显示这一项。

### 内置 Agent 模式

新建会话时，除官方的标准 / PTC / 极简 / 创造外，还可以选：

| 模式 | 来源 | 做什么 |
|---|---|---|
| **锚定标准** | [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) | 第一轮请求只暴露极简模式那对真实工具（`bash` + `str_replace_editor`），也不自动注入工作区或技能摘要，让模型先走「We need…」那种极简推理轨迹；会话稳住后再按需解锁标准工具（`dev_tool_search` / `skill_search`）。适合想同时保住极简轨迹和标准能力的工程任务。 |
| **路由标准** | [yjh051108/dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) | 读第一句用户消息，把任务分到规划优先（spec）或执行优先（react），首轮只用小工具面、想一段做一段；第一次真正调用工具后再打开完整标准工具。适合任务类型差很多、不希望一种思维模式打天下的会话。 |

两个模式都写进 `$DSH_HOME/.agent-presets/`。自己改过同名目录的话，应用不会覆盖。

### Web 远程控制

电脑端的 DSH 开着时，手机浏览器可以打开同一套界面，查看和操作都跟本机同步。

两种通道，按需要打开：

- **局域网**：手机和电脑连同一 Wi-Fi 或热点。面板会给出本机地址和二维码。第一次开的时候，如果 Windows 弹出防火墙提示，勾选「专用网络」并允许访问。
- **公网**：走 Cloudflare 隧道，手机用流量也能进。隧道地址每次启动可能变化，面板里点「刷新链接」即可。

链接里已经带好访问令牌，请不要转发给别人。令牌可以重置，重置后旧链接立刻失效，需要重新复制或再扫一次码。端口也能改，改完重新打开开关即可。
