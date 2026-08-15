# 安装器设计约定（Go 原生）

> 本文是 dsh-desktop 安装器的**唯一权威规范**。改动打包流程前必须先读本文；
> 不要凭 electron-builder 的默认经验另起炉灶。

## 一、不可动摇的原则

1. **双击秒开**：安装器是 Go 原生 Win32 可执行程序（`loader/main.go`），启动即显示窗口，
   没有 Electron / NSIS 的加载延迟。
2. **不压缩**：数据以追加字节直接封进安装器 exe，安装时原样写出。压缩只会拖慢安装且无收益。
3. **蓝色海洋/鲸鱼主题**，与 Electron 界面统一（不是棕色、不是红鲸）。
4. **三步流程**：选路径 → 安装进度 → 完成（可选启动）。
5. **明确禁止**：electron-builder 的 `portable` / `nsis` 目标、NSIS 脚本、任何压缩。
   这些都是历史弃用路线，见「九、历史残留」。

## 二、架构总览

单个安装器 exe = **Go 加载器** + 两段**追加数据**：

- **shell**：`website/download/win-unpacked`（`electron-builder --win dir` 的产物，
  21 个文件 ~190MB，Electron 壳 + `app.asar`），安装到目标根目录。
- **runtime**：`output/dsh-runtime`（`prepare-runtime.mjs` 的产物，deepseek-harness
  内核 + 本地构建覆盖，14337 个文件），安装到 `<target>/resources/dsh-runtime`。

安装时 Go 加载器按内嵌 manifest 把两段数据直接解压到用户选的目录，不做压缩。

## 三、容器字节布局

```
[Go loader exe]
[shell files ...]             按 size 升序
[shell manifest JSON]          { files: [{path, offset, size}] }
[u32 len][DSHSHL01]
[runtime files ...]           按 size 升序
[runtime manifest JSON]        { shellManifestLen, files: [{path, offset, size}] }
[u32 len][DSHPLD01]
```

- magic：shell = `DSHSHL01`，runtime = `DSHPLD01`（与 `loader/main.go` 的常量一致）
- shell 与 runtime 文件都**按 size 升序**排序（`scripts/append-payload.mjs`）
- runtime manifest 额外携带 `shellManifestLen`，供加载器定位 shell 段边界

## 四、打包唯一入口

```powershell
pnpm dist:win
```

依次执行（`package.json` 的 `dist:win`）：

1. `generate:icon` / `generate:splash` / `generate:loader-bg` —— 生成图标、启动图、
   `loader/installer-bg.png`（760x480 横版背景）
2. `prepare:runtime` —— 构建本地 deepseek-harness 源码，下载 `upstream.lock.json` 锁定的
   npm 内核作为依赖树，再把本地 `@deepseek-ai/dsh-*` 的 `lib/` 与 Web 前端 `dist/`
   覆盖到内核上，产出 `output/dsh-runtime`
3. `electron-builder --win dir --x64` —— 产出 `website/download/win-unpacked`（注意是
   `--win dir`，命令行覆盖了 `build.win.target`）
4. `set-icon.cjs` —— 给 Electron 主程序设图标
5. `append-payload.mjs` —— 组装最终 `website/download/dsh-desktop-setup-x64.exe`
6. `write-latest-yml.mjs` —— 写 `website/download/latest.yml`（更新功能用）

## 五、关键脚本

| 脚本 | 职责 |
|------|------|
| `scripts/prepare-runtime.mjs` | 本地 harness 构建覆盖到 npm 内核 → `output/dsh-runtime`；须一并拷贝 `cordis.patch.yml`/`cordis.yml`（bundle manifest） |
| `scripts/append-payload.mjs` | 复制 `assets/icon.ico`→`loader/icon.ico`；`go build -ldflags '-s -w -H windowsgui'`；rcedit `--set-icon`；按 size 升序排序 shell+runtime 文件；组装最终 exe |
| `scripts/generate-loader-bg.mjs` | sharp 生成 `loader/installer-bg.png`（760x480）与 `loader-bg.png` |
| `scripts/write-latest-yml.mjs` | 写 `latest.yml`（version / sha512 / size / release URL） |

## 六、UI 规范（`loader/main.go`）

- 窗口 760x480，`WS_POPUP` 无边框，圆角 18px（`SetWindowRgn`），自绘标题栏。
- 标题栏高 40px：左侧「DSH Desktop」，右侧最小化（`winW-84..winW-42`）与关闭（`winW-42..winW`）。
- 品牌蓝 `#4D6BFE`；背景海洋渐变来自 `installer-bg.png`。
- 目录页：标题「选择安装目录」、输入框（90,232,470,36）+ 浏览按钮（570,232,100,36）、
  容量提示「本次安装约需 X · 目标盘剩余 Y」（`GetDiskFreeSpaceExW`）、安装按钮（590,386,130,44）。
- **单实例**：`CreateMutexW`（`Local\` 会话级）防重复打开；第二个实例激活已有窗口后退出。
  提权交接（`--dir`）实例会短暂重试互斥量，原实例在 `relaunchElevated` 前 `releaseSingleInstance`。
- **自更新 worker**（`--installer-worker <目录> [--relaunch]`，由更新器以提权拉起）：**不是
  静默更新**——复用同一进度页（标题「正在更新」），完成后若带 `--relaunch` 经 explorer 以
  普通令牌启动新版并自动关窗；失败显示错误页并写 `C:\dsh-desktop-install.log`。
- **增量覆盖**：payload manifest 带每文件 `sha256`。更新时若目标文件已存在且哈希一致则跳过写入，
  只覆盖有改动的部分（首次安装仍会写出全部文件）。
- **安装前进程检测**：点「安装」后（提权副本内）用 PowerShell CIM 枚举目标目录下运行的
  DSH Desktop 进程，有则 `MessageBoxW`（是/否，默认否）询问是否结束；「是」则
  `taskkill /F /T` 并轮询至多 5s 等文件释放。「否」则中止安装。
- 进度页：进度条（70,210,winW-70,224）+ 百分比 + 状态文字。
- 完成页：✓ + 「安装完成」+「启动 DSH Desktop」复选框（默认勾选）。
- **路径文字垂直居中**：父窗口画 36px 输入槽，EDIT 按字体高度缩小后居中放入（见踩坑 6）。
  **禁止**对 EDIT 接管 `WM_PAINT` 自绘。
- **进度按文件数量统计**（`done / totalFiles`），**不是**按字节数——否则 21 个 shell 大文件
  会秒冲到 66%，然后 14337 个 runtime 小文件拖成龟速。
- **复制进度封顶 99%**：文件复制完成后进入「正在初始化应用…」阶段（状态文字即此文案，
  进度条停在 99%），后台排空文件预热读回（见 §八-0），再写 ini/注册表/快捷方式/
  Defender 排除，全部完成后才跳到 100% 并显示完成页。

## 七、Go Win32 踩坑记录（勿重蹈覆辙）

1. **`runtime.LockOSThread()` 必须**：Win32 窗口消息线程亲和，缺失则窗口「未响应」。
2. **COLORREF 是 0x00BBGGRR（BGR 字节序）**：用 `colref(r,g,b)` 生成，手写会串色。
3. **`FillRect` 在 user32.dll**，不在 gdi32.dll。
4. **`PostQuitMessage` 只对调用线程生效**：关窗口用 `PostMessage(hwnd, WM_CLOSE)`。
5. **离屏/背景 DC 必须用窗口 DC 创建（`getDC(hwnd)`），不能用屏幕 DC（`getDC(0)`）**：
   屏幕 DC 派生的兼容 DC 与窗口 DC 不兼容，`BitBlt` 静默失败，整窗变黑只剩子控件。
6. **单行 EDIT 文字垂直居中**：`EM_SETRECT` 只对多行 EDIT 有效。**不要**子类化
   接管 `WM_PAINT` 再 `DrawTextW` + `DT_VCENTER`——点击时原过程会再用 `GetDC`
   在默认基线画一遍同一串文字，路径框出现重影。正确做法：父窗口画 36px 高的
   输入槽，EDIT 本身按 `GetTextMetrics` 的单元格高度缩小并垂直居中放进槽里，
   用 `EM_SETMARGINS` 做左右内边距，让系统自己画文字和 caret；点到槽的上下
   留白时由父窗口 `SetFocus` 给 EDIT。
7. **rcedit 只能 `--set-icon`**：Go 构建的 exe 无版本资源，版本字符串选项报
   "Unable to change version string"。
8. **`go build` 要在 `loader/` 目录执行**，且 `icon.ico`、`installer-bg.png` 需先就位。
9. **组装前先 kill 正在运行的安装器 exe**（否则 EBUSY 文件锁）。
10. electron-builder 下载走中国镜像：`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`
    指向 npmmirror。
11. **Go 默认构建为控制台子系统**，Explorer 双击安装器会额外弹一个黑窗口。必须
    `-H windowsgui`；GUI 子系统下再 spawn `reg` / `powershell` 等控制台子进程时，
    必须带 `CREATE_NO_WINDOW`（0x08000000，见 `hideConsole`），否则它们会各自闪窗。
12. **安装器在「安装」点击时自提权**：写 HKLM、`C:\dsh-desktop.ini`、ProgramData 快捷方式和
    Defender 排除都需要管理员令牌，而 Go 构建的 exe 没有 manifest。设计是**启动不提权**
    （保持双击秒开），点「安装」时用 `OpenProcessToken`+`TokenElevation` 检测，非提权则
    `ShellExecuteW(runas)` 带 `--dir <目录>` 重拉一次 UAC，提权副本直接进进度页安装；
    用户取消 UAC 或设 `DSH_SETUP_NO_ELEVATE=1`（自动化/UI 测试）则降级为普通令牌安装，
    特权步骤静默失败。

## 八、安装后动作（`installTo`）

0. **文件预热（安装期内并行）**：每个文件写完后即被后台 worker 按 1 MiB 块读回一遍
   （`warmQueue`/`warmWorker`），把杀软扫描与系统缓存预热分摊到安装过程中；复制结束
   后在「正在初始化应用…」阶段排空队列。首次启动因此省掉冷读 + 实时扫描的大头开销。
1. 写 `C:\dsh-desktop.ini`（`InstallPath=...`），作为下次默认目录。
2. 注册表卸载项 `HKLM\...\Uninstall\2964e23e-3f18-500c-b3e7-68e9fa24df7a`。
3. 桌面 + 开始菜单快捷方式（`powershell` + `WScript.Shell`）。
4. **Defender 排除**（`defenderExclude`，best-effort）：`Add-MpPreference -ExclusionPath`
   把安装目录加入 Windows Defender 排除列表，首启及后续启动跳过实时扫描；卸载时由
   `electron/main.mjs` 的 `runUninstallWorker` 用 `Remove-MpPreference` 移除。

## 九、历史残留（勿再使用）

以下文件/配置是旧的 NSIS/portable/内置窗口路线，**已弃用，勿据此恢复打包方式**：

- `scripts/installer.nsh`、`scripts/patch-portable-template.mjs`、`patch:portable` 脚本
- `electron/installer.html`（旧内置安装窗口，已被 Go 安装器取代）
- `package.json` 里 `build.win.target: portable` 与 `portable` 配置块（被 `--win dir` 覆盖）
