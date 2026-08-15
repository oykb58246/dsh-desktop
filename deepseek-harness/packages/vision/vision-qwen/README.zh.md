# @deepseek-ai/dsh-vision-qwen

DeepSeek Harness 的内置 Qwen-VL 视觉桥，设计参考
[QwenLM/Qwen-MM-Plugins](https://github.com/QwenLM/Qwen-MM-Plugins) 的视觉能力
（Apache-2.0）：用户粘贴到对话中的图片先存入持久化附件服务；当所选模型自身
不能读取像素时，`agent/pre-step` 扩展点把每条图片块转换成由 Qwen-VL 模型生成的
稳定文字描述。因此纯文本模型（包括 DeepSeek V4 Flash 与 Pro）也能"看到"用户
贴出的图片，配套的 `vision_chat` 工具还可以让模型针对某张图片追问细节。
`screenshot` 工具更进一步：模型可自行截取屏幕、某个窗口或屏幕区域，交给
Qwen-VL 分析后以文本返回——需要"看"实时界面的任务不再依赖用户手动贴图。

## 模型体验

- **模型可见：** 每张图片变成以 `【图片附件 sha256:<id>】` 开头、携带 Qwen-VL
  描述的一个文本块，会话记录本身即可重建模型看到的全部内容。提示词段说明该
  标记格式与 `vision_chat` 工具的用法。
- **截图：** `screenshot` 工具按参数截取整屏（虚拟屏幕）、窗口（Windows 按进程名
  或标题匹配，macOS 按 CGWindow id）或绝对屏幕区域，PNG 直接发送给配置的
  Qwen-VL 端点；`question` 缺省时使用 `describePrompt` 全文描述。
- **Token：** 每步每张图片一次视觉调用，图片只发送给配置的 Qwen-VL 端点一次；
  描述文本计入文本模型的上下文窗口。截图工具每次调用一次视觉请求。
- **KV-cache：** 除 harness 自身的历史复用外无额外影响；桥仅为 `vision_chat`
  保留最近 64 个附件的运行时记忆，不落盘。

## 配置

所有字段均可选（`vision-qwen` 设置段，叠加在组合条目之上）：

```yaml
- id: vision-qwen
  config:
    enabled: true   # 默认开启
    baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
    model: qwen-vl-max-latest
    apiKeyEnv: DASHSCOPE_API_KEY
    describePrompt: ...
```

API 密钥通过凭据服务解析（环境变量 `DASHSCOPE_API_KEY`、`$DSH_HOME/.env` 或
Web 凭据存储）。桥开启后，host 的输入准入允许纯文本模型接收图片；关闭后恢复
严格的图片拦截。

## 已知限制与待办

- 粘贴的图片在会话记录中以其文字描述呈现，而非原始图片；已含原始图片块的会话
  （此前通过原生视觉模型发送）切换到纯文本模型时仍会在请求期失败。
- 视觉端点固定为 OpenAI 兼容的 chat-completions 路由；桥不消费流式视觉响应
  （等待完整答案）。
- `screenshot` 的窗口捕获依赖目标窗口可被 `PrintWindow`/`GetWindowRect` 读取
  （Windows）；被遮挡的窗口优先用 `PrintWindow` 全内容渲染，失败时回退到屏幕
  区域拷贝。Linux 需要 ImageMagick 的 `import` 命令。
